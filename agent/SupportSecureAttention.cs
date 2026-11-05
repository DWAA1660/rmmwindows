using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using LibraryRmm.Support;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace LibraryRmm.Agent;

internal sealed class SupportSecureAttentionPolicy(bool controlRequested)
{
    private readonly HashSet<Guid> seen = [];
    private DateTimeOffset last = DateTimeOffset.MinValue;
    public bool TryBegin(string requestId, DateTimeOffset now)
    {
        if (!controlRequested || !Guid.TryParseExact(requestId, "D", out var id) || seen.Contains(id) ||
            now - last < TimeSpan.FromSeconds(5) || seen.Count >= 500) return false;
        seen.Add(id); last = now; return true;
    }
    public static string ParseRequest(string line)
    {
        if (line.Length > 512) throw new InvalidDataException("Oversized support broker request.");
        using var document = JsonDocument.Parse(line);
        var value = document.RootElement;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != 2 ||
            !value.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "secureAttention" ||
            !value.TryGetProperty("requestId", out var request) || request.ValueKind != JsonValueKind.String || !Guid.TryParseExact(request.GetString(), "D", out _))
            throw new InvalidDataException("Invalid support broker request.");
        return request.GetString()!;
    }
}

internal static class SupportSecureAttention
{
    /// <param name="targetUser">The signed-in user's token, or null for a sign-in-screen session where the
    /// LocalSystem service itself requests the secure attention sequence.</param>
    public static (bool Success, string Message) Request(SafeAccessTokenHandle? targetUser)
    {
        try
        {
            // Honor the existing Windows policy. Never enable software SAS, change the registry,
            // send fake key chords, or attempt to bypass secure-desktop authentication.
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", writable: false);
            if (key?.GetValue("SoftwareSASGeneration") is not int policy || policy is not (1 or 3)) return (false, "policy_not_enabled");
            if (targetUser is null) SendSAS(false);
            else WindowsIdentity.RunImpersonated(targetUser, () => SendSAS(false));
            // SendSAS is void. This confirms only a permitted request, never a desktop transition.
            return (true, "sent");
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException or PlatformNotSupportedException)
        { return (false, "not_available"); }
        catch (Exception exception) when (exception is System.Security.SecurityException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or IOException or InvalidOperationException)
        { return (false, "failed"); }
    }
    [DllImport("sas.dll", CallingConvention = CallingConvention.Winapi)] private static extern void SendSAS([MarshalAs(UnmanagedType.Bool)] bool asUser);
}
