using System.Text;

namespace LibraryRmm.Agent;

/// <summary>
/// Incrementally decodes a redirected process stream that may switch between UTF-8 and
/// UTF-16LE. PowerShell writes UTF-8 (the wrapper sets the console code page), but some
/// Windows tools — notably sfc.exe — write raw UTF-16LE when their stdout is a pipe. Decoding
/// those bytes as UTF-8 produced NUL-separated text, so the stream is classified as it arrives.
///
/// Heuristics (documented limits — arbitrary unmarked mixed encodings cannot be detected
/// perfectly):
/// * Narrow → wide: a UTF-16LE BOM, or two consecutive code units of the form (ASCII, 0x00).
/// * Wide → narrow: three consecutive code units in which BOTH bytes are printable ASCII
///   (or TAB/CR/LF). English UTF-16 never contains such units, but runs of certain CJK
///   characters could be misread as UTF-8 text.
/// Bytes are only held back when they are a possible start of a switch, so ordinary
/// progress text (for example "\rScanning 42%") is emitted as soon as it is read.
/// </summary>
internal sealed class AdaptiveOutputDecoder
{
    private const int NarrowRunUnits = 3;
    private readonly Decoder narrow = new UTF8Encoding(false).GetDecoder();
    private readonly Decoder wide = new UnicodeEncoding(bigEndian: false, byteOrderMark: false).GetDecoder();
    private byte[] pending = [];
    private bool isWide;
    private byte lastNarrowByte;

    public bool IsWide => isWide;

    public string Decode(ReadOnlySpan<byte> input) => Process(input, final: false);

    public string Flush() => Process(ReadOnlySpan<byte>.Empty, final: true);

    private string Process(ReadOnlySpan<byte> input, bool final)
    {
        var data = new byte[pending.Length + input.Length];
        pending.CopyTo(data, 0);
        input.CopyTo(data.AsSpan(pending.Length));
        var output = new StringBuilder();
        var position = 0;
        while (position < data.Length)
        {
            if (isWide)
            {
                var (switchAt, holdAt) = FindNarrowStart(data, position, final);
                var end = switchAt ?? holdAt ?? data.Length;
                var aligned = position + ((end - position) & ~1);
                AppendDecoded(output, wide, data, position, aligned - position, flush: switchAt.HasValue);
                position = aligned;
                if (switchAt.HasValue) { isWide = false; continue; }
                break; // Remaining odd byte or held run stays pending.
            }
            else
            {
                var (switchAt, resumeAt, holdAt) = FindWideStart(data, position, final);
                var end = switchAt ?? holdAt ?? data.Length;
                AppendDecoded(output, narrow, data, position, end - position, flush: switchAt.HasValue);
                if (end > position) lastNarrowByte = data[end - 1];
                position = end;
                if (switchAt.HasValue)
                {
                    isWide = true;
                    position = resumeAt!.Value;
                    continue;
                }
                break;
            }
        }
        pending = data[position..];
        if (final)
        {
            // Only an odd trailing byte can remain in wide mode; let the decoder report it.
            AppendDecoded(output, isWide ? wide : narrow, pending, 0, pending.Length, flush: true);
            pending = [];
        }
        return output.ToString();
    }

    // Returns where wide decoding should begin (switchAt) and where to resume after skipping
    // a BOM or an already-emitted low byte (resumeAt), or where to hold bytes for more input.
    private (int? switchAt, int? resumeAt, int? holdAt) FindWideStart(byte[] data, int position, bool final)
    {
        for (var i = position; i < data.Length; i++)
        {
            if (data[i] == 0xFF)
            {
                if (i + 1 >= data.Length) return final ? (null, null, null) : (null, null, i);
                if (data[i + 1] == 0xFE) return (i, i + 2, null);
                continue;
            }
            if (data[i] != 0) continue;
            var previousInData = i - 1 >= position;
            // Only a byte that was decoded as UTF-8 can be the low half of the first wide unit.
            var previous = previousInData ? data[i - 1] : (position == 0 ? lastNarrowByte : (byte)0);
            if (previous is 0 or >= 0x80) continue;
            // Need the high byte of the next code unit to confirm the (ASCII, 0x00) pattern.
            if (i + 2 >= data.Length)
            {
                if (final) return (null, null, null);
                return (null, null, previousInData ? i - 1 : i);
            }
            if (data[i + 1] == 0 || data[i + 2] != 0) continue; // NUL runs or a lone NUL are not UTF-16 text.
            // The low byte was either still pending (start wide there) or already emitted as
            // the same ASCII character via UTF-8 (skip its NUL high byte and continue wide).
            return previousInData ? (i - 1, i - 1, null) : (i, i + 1, null);
        }
        return (null, null, null);
    }

    private static (int? switchAt, int? holdAt) FindNarrowStart(byte[] data, int position, bool final)
    {
        var runStart = -1;
        var runUnits = 0;
        for (var i = position; i + 1 < data.Length; i += 2)
        {
            if (IsNarrowLooking(data[i]) && IsNarrowLooking(data[i + 1]))
            {
                if (runUnits == 0) runStart = i;
                if (++runUnits >= NarrowRunUnits) return (runStart, null);
            }
            else runUnits = 0;
        }
        // A shorter printable run reaching the end of the stream is far more likely to be
        // UTF-8 text written after the native tool exited than a CJK character pair.
        if (runUnits > 0) return final ? (runStart, null) : (null, runStart);
        return (null, null);
    }

    private static bool IsNarrowLooking(byte value) => value is 0x09 or 0x0A or 0x0D or (>= 0x20 and <= 0x7E);

    private static void AppendDecoded(StringBuilder output, Decoder decoder, byte[] data, int offset, int count, bool flush)
    {
        var chars = new char[decoder.GetCharCount(data, offset, count, flush) + 2];
        var written = decoder.GetChars(data, offset, count, chars, 0, flush);
        output.Append(chars, 0, written);
    }
}
