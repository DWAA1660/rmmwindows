using System.Text;

namespace LibraryRmm.Agent;

/// <summary>
/// Turns a pseudo console's VT screen updates back into a plain text stream.
///
/// ConPTY does not forward what a program wrote; it repaints the screen, often sending only the
/// cells that changed (for example just the "6" when "Verification 5%" becomes "6%", positioned
/// with <c>ESC[5;14H</c>). This keeps a model of the screen and emits each row as text: new rows
/// are appended after "\r\n"; when the last emitted row changes it is re-emitted after "\r" (or
/// only the appended suffix). The result reads like the program's own output, with progress
/// lines as "\r" updates that the web console already understands.
///
/// Cells: each UTF-16 code unit occupies one cell, except East Asian wide characters, which
/// occupy two (the second holds <see cref="WideTail"/>). A surrogate pair occupies two cells,
/// one per code unit, which matches how the Windows console measures them. Rows that wrapped
/// because text reached the right edge are joined back without a line break.
///
/// Limits: rows above the last emitted row that are repainted later are not re-emitted (a
/// full-screen UI is not reproduced), clearing the screen continues below the text already
/// shown instead of erasing it, combining characters/emoji sequences may misplace later
/// diff updates on the same row, and colors and cursor styling are dropped.
/// </summary>
internal sealed class VtTextConverter
{
    private const char WideTail = '￿';
    private const int MaxSequenceLength = 4096;

    private enum State { Ground, Escape, EscapeIntermediate, Csi, ControlString, ControlStringEscape }

    private readonly int width;
    private readonly int height;
    private readonly Dictionary<long, char[]> rows = [];
    private readonly HashSet<long> softWrapped = [];
    private readonly StringBuilder csi = new();
    private State state;
    private int controlStringLength;
    private long baseRow;             // absolute index of viewport row 0
    private int row, col, savedRow, savedCol;
    private long highestWritten = -1; // highest absolute row that received text
    private long emittedRow = -1;
    private string emittedText = "";
    private char? pendingHighSurrogate;

    public VtTextConverter(int width, int height)
    {
        if (width < 2 || height < 1) throw new ArgumentOutOfRangeException(nameof(width));
        this.width = width;
        this.height = height;
    }

    /// <summary>Consumes decoded VT text and returns the plain text that became final or changed.</summary>
    public string Feed(string input)
    {
        foreach (var character in input) Process(character);
        return Render(final: false);
    }

    /// <summary>Returns any remaining text; ends with a line break when the cursor left the last row.</summary>
    public string Flush()
    {
        if (pendingHighSurrogate is not null) { pendingHighSurrogate = null; Print('�', null); }
        return Render(final: true);
    }

    private void Process(char character)
    {
        switch (state)
        {
            case State.Escape: Escape(character); return;
            case State.EscapeIntermediate:
                // ESC ( B and similar character-set designations: one final byte follows.
                if (character is >= '0' and <= '~' || ++controlStringLength > 8) state = State.Ground;
                return;
            case State.Csi:
                if (character is >= '@' and <= '~')
                {
                    state = State.Ground;
                    Csi(csi.ToString(), character);
                    csi.Clear();
                }
                else if (character == '\u001b') { csi.Clear(); state = State.Escape; }
                else if (character is '\u0018' or '\u001a' || csi.Length > 64) { csi.Clear(); state = State.Ground; }
                else csi.Append(character);
                return;
            case State.ControlString:
                // OSC/DCS/APC/PM strings (window title etc.) end with BEL or ESC \ and carry no text.
                if (character == '\u0007' || ++controlStringLength > MaxSequenceLength) state = State.Ground;
                else if (character == '\u001b') state = State.ControlStringEscape;
                return;
            case State.ControlStringEscape:
                if (character == '\\') state = State.Ground;
                else if (character == '\u001b') { }
                else state = State.ControlString;
                return;
        }
        switch (character)
        {
            case '\u001b': state = State.Escape; return;
            case '\r': col = 0; return;
            case '\n' or '\u000b' or '\u000c': LineFeed(); return;
            case '\b': col = Math.Max(0, Math.Min(col, width - 1) - 1); return;
            case '\t': col = Math.Min(width - 1, (col / 8 + 1) * 8); return;
        }
        if (character < ' ' || character is >= '\u007f' and <= '\u009f') return;
        if (char.IsHighSurrogate(character))
        {
            if (pendingHighSurrogate is not null) Print('�', null);
            pendingHighSurrogate = character;
            return;
        }
        if (char.IsLowSurrogate(character))
        {
            if (pendingHighSurrogate is { } high) { pendingHighSurrogate = null; Print(high, character); }
            else Print('�', null);
            return;
        }
        if (pendingHighSurrogate is not null) { pendingHighSurrogate = null; Print('�', null); }
        Print(character, null);
    }

    private void Escape(char character)
    {
        state = State.Ground;
        switch (character)
        {
            case '[': csi.Clear(); state = State.Csi; break;
            case ']' or 'P' or '_' or '^' or 'X': controlStringLength = 0; state = State.ControlString; break;
            case '(' or ')' or '*' or '+' or '#' or '%' or ' ': controlStringLength = 0; state = State.EscapeIntermediate; break;
            case '\u001b': state = State.Escape; break;
            case '7': savedRow = row; savedCol = col; break;
            case '8': row = savedRow; col = savedCol; break;
            case 'M': if (row > 0) row--; else ScrollDown(1); break;
            case 'E': col = 0; LineFeed(); break;
            case 'D': LineFeed(); break;
            case 'c': ClearScreen(); row = 0; col = 0; break;
        }
    }

    private void Print(char first, char? second)
    {
        var cells = second is not null || IsWide(first) ? 2 : 1;
        if (col + cells > width)
        {
            // Autowrap (also when a wide character does not fit in the last column).
            softWrapped.Add(baseRow + row);
            col = 0;
            LineFeed();
        }
        var absolute = baseRow + row;
        var line = Row(absolute);
        line[col] = first;
        if (cells == 2) line[col + 1] = second ?? WideTail;
        Repair(line, col);
        Repair(line, col + cells);
        col += cells; // col == width means "wrap before the next character".
        highestWritten = Math.Max(highestWritten, absolute);
    }

    // Keeps the cell pair (index - 1, index) consistent after an overwrite or erase: a wide lead
    // or high surrogate without its tail (or a tail without its lead) becomes a blank.
    private void Repair(char[] line, int index)
    {
        if (index <= 0 || index > width) return;
        var lead = line[index - 1];
        var tail = index < width ? line[index] : ' ';
        var leadWide = IsWide(lead);
        var leadHigh = char.IsHighSurrogate(lead);
        if (leadWide && tail != WideTail || leadHigh && !char.IsLowSurrogate(tail)) line[index - 1] = ' ';
        if (index < width && (tail == WideTail && !leadWide || char.IsLowSurrogate(tail) && !leadHigh)) line[index] = ' ';
    }

    private void LineFeed()
    {
        if (row < height - 1) row++;
        else baseRow++; // Bottom of the screen: content scrolls up.
    }

    private char[] Row(long absolute)
    {
        if (!rows.TryGetValue(absolute, out var line))
        {
            line = new char[width];
            Array.Fill(line, ' ');
            rows[absolute] = line;
        }
        return line;
    }

    private void Csi(string parameters, char final)
    {
        if (parameters.Length > 0 && parameters[0] is '?' or '>' or '=' or '<') return; // Private modes (cursor visibility, focus events, ...).
        if (parameters.Any(character => character is (>= ' ' and <= '/'))) return; // Intermediates (cursor style etc.).
        var values = parameters.Length == 0 ? [] : parameters.Split(';', ':').Select(p => int.TryParse(p, out var v) ? v : 0).ToArray();
        int Arg(int index, int fallback) => index < values.Length && values[index] > 0 ? Math.Min(values[index], 100_000) : fallback;
        var mode = values.Length > 0 ? values[0] : 0;
        switch (final)
        {
            case 'H' or 'f': row = Math.Clamp(Arg(0, 1) - 1, 0, height - 1); col = Math.Clamp(Arg(1, 1) - 1, 0, width - 1); break;
            case 'A': row = Math.Max(0, row - Arg(0, 1)); col = Math.Min(col, width - 1); break;
            case 'B' or 'e': row = Math.Min(height - 1, row + Arg(0, 1)); col = Math.Min(col, width - 1); break;
            case 'C' or 'a': col = Math.Min(width - 1, col + Arg(0, 1)); break;
            case 'D': col = Math.Max(0, Math.Min(col, width - 1) - Arg(0, 1)); break;
            case 'E': row = Math.Min(height - 1, row + Arg(0, 1)); col = 0; break;
            case 'F': row = Math.Max(0, row - Arg(0, 1)); col = 0; break;
            case 'G' or '`': col = Math.Clamp(Arg(0, 1) - 1, 0, width - 1); break;
            case 'd': row = Math.Clamp(Arg(0, 1) - 1, 0, height - 1); col = Math.Min(col, width - 1); break;
            case 'S': baseRow += Math.Min(Arg(0, 1), height); break;
            case 'T': ScrollDown(Arg(0, 1)); break;
            case 'L': ShiftRows(baseRow + row, Arg(0, 1)); break;
            case 'M':
                if (row == 0) baseRow += Math.Min(Arg(0, 1), height); // Delete at the top = scroll up.
                else ShiftRows(baseRow + row, -Arg(0, 1));
                break;
            case 'K': EraseLine(mode); break;
            case 'X': Erase(baseRow + row, Math.Min(col, width - 1), Math.Min(width, Math.Min(col, width - 1) + Arg(0, 1))); break;
            case 'P' or '@': ShiftCells(final == '@' ? Arg(0, 1) : -Arg(0, 1)); break;
            case 'J':
                if (mode == 2) ClearScreen();
                else if (mode == 0)
                {
                    EraseLine(0);
                    for (var next = baseRow + row + 1; next < baseRow + height; next++) Erase(next, 0, width);
                }
                else if (mode == 1)
                {
                    for (var next = baseRow; next < baseRow + row; next++) Erase(next, 0, width);
                    EraseLine(1);
                }
                break; // Mode 3 (erase scrollback) does not touch the visible screen.
        }
    }

    private void ClearScreen()
    {
        // Keep everything already shown and continue on fresh rows below it.
        if (highestWritten >= baseRow) baseRow = highestWritten + 1;
    }

    private void ScrollDown(int count) => ShiftRows(baseRow, count);

    // Moves rows [from, bottom] by delta (positive = down) within the visible screen.
    private void ShiftRows(long from, int delta)
    {
        var bottom = baseRow + height - 1;
        delta = Math.Clamp(delta, -height, height);
        if (delta == 0 || from > bottom) return;
        var moved = rows.Where(entry => entry.Key >= from && entry.Key <= bottom).ToArray();
        foreach (var entry in moved) { rows.Remove(entry.Key); softWrapped.Remove(entry.Key); }
        foreach (var (key, line) in moved)
        {
            var target = key + delta;
            if (target < from || target > bottom) continue;
            rows[target] = line;
            if (target > highestWritten && line.Any(cell => cell != ' ')) highestWritten = target;
        }
    }

    private void ShiftCells(int delta)
    {
        var line = Row(baseRow + row);
        var start = Math.Min(col, width - 1);
        var count = Math.Min(Math.Abs(delta), width - start);
        if (delta < 0)
        {
            Array.Copy(line, start + count, line, start, width - start - count);
            Array.Fill(line, ' ', width - count, count);
        }
        else
        {
            Array.Copy(line, start, line, start + count, width - start - count);
            Array.Fill(line, ' ', start, count);
            Repair(line, start + count);
            Repair(line, width - 1);
            Repair(line, width);
        }
        Repair(line, start);
    }

    private void EraseLine(int mode)
    {
        var absolute = baseRow + row;
        var cursor = Math.Min(col, width - 1);
        if (mode == 1) Erase(absolute, 0, cursor + 1);
        else if (mode == 2) Erase(absolute, 0, width);
        else Erase(absolute, cursor, width);
    }

    private void Erase(long absolute, int from, int to)
    {
        if (!rows.TryGetValue(absolute, out var line)) return;
        to = Math.Min(to, width);
        if (to <= from) return;
        Array.Fill(line, ' ', from, to - from);
        Repair(line, from);
        Repair(line, to);
        if (to == width) softWrapped.Remove(absolute);
    }

    private string Text(long absolute)
    {
        if (!rows.TryGetValue(absolute, out var line)) return "";
        var builder = new StringBuilder(width);
        foreach (var cell in line) if (cell != WideTail) builder.Append(cell);
        // A wrapped row continues on the next row; its trailing blanks are real text.
        return softWrapped.Contains(absolute) ? builder.ToString() : builder.ToString().TrimEnd(' ');
    }

    private string Render(bool final)
    {
        var output = new StringBuilder();
        if (emittedRow >= 0)
        {
            var current = Text(emittedRow);
            if (current != emittedText)
            {
                if (current.StartsWith(emittedText, StringComparison.Ordinal)) output.Append(current, emittedText.Length, current.Length - emittedText.Length);
                else output.Append('\r').Append(current);
                emittedText = current;
            }
        }
        for (var next = emittedRow + 1; next <= highestWritten; next++)
        {
            if (emittedRow >= 0 && !softWrapped.Contains(next - 1)) output.Append("\r\n");
            emittedText = Text(next);
            output.Append(emittedText);
            emittedRow = next;
        }
        if (final && emittedRow >= 0 && baseRow + row > emittedRow && !softWrapped.Contains(emittedRow)) output.Append("\r\n");
        // Rows before the last emitted row can no longer change the output; drop them so long
        // runs use bounded memory.
        foreach (var stale in rows.Keys.Where(key => key < emittedRow).ToArray()) rows.Remove(stale);
        softWrapped.RemoveWhere(key => key < emittedRow - 1);
        return output.ToString();
    }

    /// <summary>East Asian wide/fullwidth BMP characters, which the console draws in two cells.</summary>
    internal static bool IsWide(char c) => c switch
    {
        >= 'ᄀ' and <= 'ᅟ' => true,
        '⌚' or '⌛' or '〈' or '〉' or '⏰' or '⏳' => true,
        >= '⏩' and <= '⏬' => true,
        '◽' or '◾' or '☔' or '☕' or '♿' or '⚓' or '⚡' or '⚪' or '⚫' => true,
        >= '♈' and <= '♓' => true,
        '⚽' or '⚾' or '⛄' or '⛅' or '⛎' or '⛔' or '⛪' or '⛲' or '⛳' or '⛵' or '⛺' or '⛽' => true,
        '✅' or '✊' or '✋' or '✨' or '❌' or '❎' or '❗' or '➰' or '➿' => true,
        >= '❓' and <= '❕' => true,
        >= '➕' and <= '➗' => true,
        '⬛' or '⬜' or '⭐' or '⭕' => true,
        >= '⺀' and <= '〾' => true,
        >= 'ぁ' and <= '㏿' => true,
        >= '㐀' and <= '䶿' => true,
        >= '一' and <= '鿿' => true,
        >= 'ꀀ' and <= '꓏' => true,
        >= 'ꥠ' and <= '꥿' => true,
        >= '가' and <= '힣' => true,
        >= '豈' and <= '﫿' => true,
        >= '︐' and <= '︙' => true,
        >= '︰' and <= '﹯' => true,
        >= '＀' and <= '｠' => true,
        >= '￠' and <= '￦' => true,
        _ => false
    };
}
