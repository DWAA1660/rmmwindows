using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace LibraryRmm.Support;

internal static class DesktopCapture
{
    public static byte[] Capture(Rectangle bounds)
    {
        using var original = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(original))
        {
            graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
            DrawCursor(graphics, bounds);
        }
        var scale = Math.Min(1d, 1600d / original.Width);
        using var scaled = new Bitmap(Math.Max(1, (int)(original.Width * scale)), Math.Max(1, (int)(original.Height * scale)), PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(scaled))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
            graphics.DrawImage(original, new Rectangle(Point.Empty, scaled.Size));
        }
        var codec = ImageCodecInfo.GetImageEncoders().First(info => info.FormatID == ImageFormat.Jpeg.Guid);
        foreach (var quality in new[] { 65L, 45L, 25L, 10L })
        {
            using var output = new MemoryStream();
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            scaled.Save(output, codec, parameters);
            if (output.Length <= 1024 * 1024) return output.ToArray();
        }
        throw new InvalidOperationException("Desktop frame exceeds the relay's 1 MiB limit.");
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
    [StructLayout(LayoutKind.Sequential)] private struct CursorInformation { public int Size, Flags; public IntPtr Cursor; public Point Position; }
    [StructLayout(LayoutKind.Sequential)] private struct IconInformation { public int IsIcon; public uint HotspotX, HotspotY; public IntPtr Mask, Color; }
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CursorInformation information);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon, out IconInformation information);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr context, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
}
