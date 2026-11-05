using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace LibraryRmm.Support;

internal static class DesktopAccess
{
    public static bool Available(int expectedSession)
    {
        if (Process.GetCurrentProcess().SessionId != expectedSession) return false;
        if (!WTSQuerySessionInformation(IntPtr.Zero, expectedSession, 8, out var state, out var length)) return false;
        try { if (length < 4 || Marshal.ReadInt32(state) != 0) return false; }
        finally { WTSFreeMemory(state); }
        var desktop = OpenInputDesktop(0, false, 0x101);
        if (desktop == IntPtr.Zero) return false;
        try
        {
            var name = new StringBuilder(256);
            return GetUserObjectInformation(desktop, 2, name, name.Capacity * sizeof(char), out _) && name.ToString() == "Default";
        }
        finally { CloseDesktop(desktop); }
    }
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int information, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, int length, out int needed);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
}
