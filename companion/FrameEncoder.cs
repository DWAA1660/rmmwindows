using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace LibraryRmm.Support;

/// <summary>
/// Captures one monitor into memory and encodes only the 64-pixel tiles that changed since the previous frame
/// ("RMF1", see <see cref="SupportFrameFormat"/>). Frames are never written to disk. Monitors wider than 1920 pixels
/// are scaled down to 1920; smaller ones are sent at full resolution so text stays sharp.
/// </summary>
internal sealed class FrameEncoder : IDisposable
{
    public const int Tile = 64;
    private const int MaximumWidth = 1920;
    private const int MaximumFrameBytes = 900 * 1024;
    private static readonly ImageCodecInfo Jpeg = ImageCodecInfo.GetImageEncoders().First(info => info.FormatID == ImageFormat.Jpeg.Guid);
    private Bitmap? capture;
    private Bitmap? scaled;
    private Size sourceSize;
    private int width, height;
    private byte[] current = [], previous = [];
    private bool hasPrevious;

    public Size SurfaceSize => new(width, height);
    /// <summary>Rectangles of the last frame (diagnostics only).</summary>
    public IReadOnlyList<SupportRect> LastRects { get; private set; } = [];

    /// <summary>Captures <paramref name="bounds"/> and returns the frame to send, or null when nothing changed and no heartbeat is due.</summary>
    public byte[]? Next(Rectangle bounds, uint seq, bool keyframe, bool heartbeat)
    {
        if (bounds.Width < 1 || bounds.Height < 1) throw new InvalidOperationException("The monitor has no area.");
        if (capture is null || sourceSize != bounds.Size) Reset(bounds.Size);
        using (var graphics = Graphics.FromImage(capture!))
        {
            graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
            DrawCursor(graphics, bounds);
        }
        var surface = capture!;
        if (scaled is not null)
        {
            using var graphics = Graphics.FromImage(scaled);
            graphics.InterpolationMode = InterpolationMode.Bilinear;
            graphics.PixelOffsetMode = PixelOffsetMode.Half;
            graphics.DrawImage(capture!, new Rectangle(0, 0, width, height));
            surface = scaled;
        }
        var data = surface.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        int stride;
        try
        {
            stride = data.Stride;
            if (current.Length != stride * height) { current = new byte[stride * height]; previous = new byte[stride * height]; hasPrevious = false; }
            Marshal.Copy(data.Scan0, current, 0, stride * height);
        }
        finally { surface.UnlockBits(data); }

        var full = new SupportRect(0, 0, width, height);
        var rects = keyframe || !hasPrevious ? [full] : Changed(stride);
        if (rects.Count > 0 && rects.Sum(rect => (long)rect.Area) > (long)width * height * 55 / 100) rects = [full];
        LastRects = rects;
        (current, previous) = (previous, current);
        hasPrevious = true;
        if (rects.Count == 0) return heartbeat ? SupportFrameFormat.Build(seq, width, height, false, []) : null;
        var repaint = rects.Count == 1 && rects[0] == full;
        var parts = Encode(surface, rects, repaint ? 60L : 70L);
        if (parts.Sum(part => part.Jpeg.Length) > MaximumFrameBytes)
        {
            parts = Encode(surface, [full], 40L); repaint = true;
            if (parts[0].Jpeg.Length > MaximumFrameBytes) parts = Encode(surface, [full], 15L);
        }
        return SupportFrameFormat.Build(seq, width, height, repaint, parts);
    }

    private List<SupportRect> Changed(int stride)
    {
        int columns = (width + Tile - 1) / Tile, rows = (height + Tile - 1) / Tile;
        var dirty = new bool[columns * rows];
        for (var y = 0; y < height; y++)
        {
            var rowStart = y * stride;
            var tileRow = y / Tile * columns;
            for (var column = 0; column < columns; column++)
            {
                if (dirty[tileRow + column]) continue;
                var start = rowStart + column * Tile * 3;
                var length = Math.Min(Tile, width - column * Tile) * 3;
                if (!current.AsSpan(start, length).SequenceEqual(previous.AsSpan(start, length))) dirty[tileRow + column] = true;
            }
        }
        return SupportFrameFormat.Merge(dirty, columns, rows, Tile, width, height);
    }

    private static List<(SupportRect Rect, byte[] Jpeg)> Encode(Bitmap surface, IReadOnlyList<SupportRect> rects, long quality)
    {
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        var parts = new List<(SupportRect, byte[])>(rects.Count);
        foreach (var rect in rects)
        {
            using var crop = surface.Clone(new Rectangle(rect.X, rect.Y, rect.Width, rect.Height), PixelFormat.Format24bppRgb);
            using var output = new MemoryStream();
            crop.Save(output, Jpeg, parameters);
            parts.Add((rect, output.ToArray()));
        }
        return parts;
    }

    private void Reset(Size size)
    {
        capture?.Dispose(); scaled?.Dispose(); scaled = null;
        sourceSize = size;
        capture = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb);
        if (size.Width > MaximumWidth)
        {
            width = MaximumWidth;
            height = Math.Max(1, (int)Math.Round(size.Height * (double)MaximumWidth / size.Width));
            scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        }
        else { width = size.Width; height = size.Height; }
        current = []; previous = []; hasPrevious = false;
    }

    private static void DrawCursor(Graphics graphics, Rectangle screen)
    {
        var cursor = new CursorInformation { Size = Marshal.SizeOf<CursorInformation>() };
        if (!GetCursorInfo(ref cursor) || cursor.Flags != 1 || !screen.Contains(cursor.Position)) return;
        if (!GetIconInfo(cursor.Cursor, out var icon)) return;
        try
        {
            var context = graphics.GetHdc();
            try { DrawIconEx(context, cursor.Position.X - screen.Left - (int)icon.HotspotX, cursor.Position.Y - screen.Top - (int)icon.HotspotY, cursor.Cursor, 0, 0, 0, IntPtr.Zero, 3); }
            finally { graphics.ReleaseHdc(context); }
        }
        finally { if (icon.Mask != IntPtr.Zero) DeleteObject(icon.Mask); if (icon.Color != IntPtr.Zero) DeleteObject(icon.Color); }
    }

    public void Dispose() { capture?.Dispose(); scaled?.Dispose(); }

    [StructLayout(LayoutKind.Sequential)] private struct CursorInformation { public int Size, Flags; public IntPtr Cursor; public Point Position; }
    [StructLayout(LayoutKind.Sequential)] private struct IconInformation { public int IsIcon; public uint HotspotX, HotspotY; public IntPtr Mask, Color; }
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CursorInformation information);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon, out IconInformation information);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr context, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
}
