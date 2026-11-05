using System.Text.Json;

namespace LibraryRmm.Support;

public sealed record SupportGrant(string SessionId, string OperatorName, DateTimeOffset ExpiresAt, bool RequestedControl, string Credential,
    bool ApprovalRequired = true, int ApprovalSeconds = 15, bool ShowSessionDetails = true)
{
    public override string ToString() => $"Attended support session {SessionId}";
}

/// <summary>Sent once over the protected service/user pipe; never a command-line or disk object.</summary>
public sealed record SupportBootstrap(string ServerOrigin, SupportGrant Grant, int UserSessionId, int ServiceProcessId)
{
    public static JsonSerializerOptions Json { get; } = new(JsonSerializerDefaults.Web);
    public Uri Validate(DateTimeOffset now)
    {
        if (!Uri.TryCreate(ServerOrigin, UriKind.Absolute, out var origin) || origin.Scheme != "https" ||
            origin.UserInfo.Length != 0 || origin.AbsolutePath != "/" || origin.Query.Length != 0 || origin.Fragment.Length != 0)
            throw new InvalidDataException("Support requires the enrolled HTTPS origin.");
        if (!Guid.TryParseExact(Grant.SessionId, "D", out _) || Grant.Credential.Length != 43 ||
            Grant.Credential.Any(value => !char.IsAsciiLetterOrDigit(value) && value is not ('_' or '-')) || string.IsNullOrWhiteSpace(Grant.OperatorName) || Grant.OperatorName.Length > 150 ||
            Grant.OperatorName.Any(char.IsControl) || Grant.ExpiresAt <= now || Grant.ExpiresAt > now.AddMinutes(31) ||
            Grant.ApprovalSeconds is < 1 or > 300 || UserSessionId <= 0 || ServiceProcessId <= 0)
            throw new InvalidDataException("Invalid or expired support bootstrap.");
        return new UriBuilder(origin) { Scheme = "wss", Path = $"/api/support/{Grant.SessionId}/stream" }.Uri;
    }
    public override string ToString() => $"Attended support bootstrap {Grant.SessionId}";
}

public sealed record SupportDisplayGeometry(string Id, int Left, int Top, int Width, int Height)
{
    public (int X, int Y) MapNormalized(double x, double y)
    {
        if (!double.IsFinite(x) || !double.IsFinite(y) || x is < 0 or > 1 || y is < 0 or > 1 || Width <= 0 || Height <= 0)
            throw new InvalidDataException("Invalid monitor coordinates.");
        return (Left + (int)Math.Round(x * (Width - 1)), Top + (int)Math.Round(y * (Height - 1)));
    }
}

/// <summary>Enforces the snapshotted administrator access policy and local lifetime. Wire messages cannot directly approve or resume this gate.</summary>
public sealed class SupportPermissionGate(SupportBootstrap bootstrap, Func<DateTimeOffset> clock, Func<bool> desktopAvailable, Func<bool>? controllerReady = null)
{
    private readonly object sync = new();
    private bool approved;
    private bool control;
    private bool paused;
    private bool ended;
    private DateTimeOffset? localPolicyReadyAt;
    public bool IsApproved { get { lock (sync) return approved && !ended; } }
    public bool HasControl { get { lock (sync) return approved && control && !paused && !ended; } }
    public bool IsPaused { get { lock (sync) return paused; } }
    public bool IsEnded { get { lock (sync) return ended; } }

    public bool ApproveLocally(bool allowControl)
    {
        lock (sync)
        {
            if (approved || ended || clock() >= bootstrap.Grant.ExpiresAt || !desktopAvailable()) return false;
            approved = true;
            control = allowControl && bootstrap.Grant.RequestedControl;
            return true;
        }
    }
    public bool BeginLocalAccessPolicy()
    {
        lock (sync)
        {
            if (approved || ended || !desktopAvailable() || clock() >= bootstrap.Grant.ExpiresAt) return false;
            localPolicyReadyAt ??= clock();
            return true;
        }
    }
    public bool ApproveAfterVisibleCountdown(bool allowControl)
    {
        lock (sync)
        {
            if (!bootstrap.Grant.ApprovalRequired || !localPolicyReadyAt.HasValue || clock() - localPolicyReadyAt.Value < TimeSpan.FromSeconds(bootstrap.Grant.ApprovalSeconds)) return false;
            return ApproveLocally(allowControl);
        }
    }
    public bool ApproveImmediatePolicy(bool allowControl)
    {
        lock (sync)
        {
            if (bootstrap.Grant.ApprovalRequired || !localPolicyReadyAt.HasValue) return false;
            return ApproveLocally(allowControl);
        }
    }
    public void PauseLocally() { lock (sync) { if (approved && !ended) paused = true; } }
    public bool ResumeLocally()
    {
        lock (sync)
        {
            if (!approved || ended || clock() >= bootstrap.Grant.ExpiresAt || !desktopAvailable()) return false;
            paused = false;
            return true;
        }
    }
    public void End() { lock (sync) { ended = true; control = false; } }
    public bool TryCapture(Action capture) => TryAccess(requireControl: false, capture);
    public bool TryInput(Action input) => TryAccess(requireControl: true, input);
    private bool TryAccess(bool requireControl, Action operation)
    {
        lock (sync)
        {
            if (clock() >= bootstrap.Grant.ExpiresAt) { ended = true; control = false; }
            if (!approved || paused || ended || (requireControl && !control)) return false;
            if (controllerReady?.Invoke() == false) return false;
            if (!desktopAvailable()) { paused = true; return false; }
            operation();
            return true;
        }
    }
}

public sealed record SupportInput(string Action, double? X, double? Y, int? Button, int? DeltaY, string? Key)
{
    public static readonly IReadOnlyDictionary<string, ushort> Keys = BuildKeys();
    public static SupportInput Parse(JsonElement json)
    {
        if (!json.TryGetProperty("type", out var type) || type.GetString() != "input" ||
            !json.TryGetProperty("action", out var actionValue) || actionValue.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Invalid input message.");
        var action = actionValue.GetString()!;
        if (action is not ("move" or "down" or "up" or "wheel" or "keyDown" or "keyUp" or "releaseAll"))
            throw new InvalidDataException("Unknown input action.");
        double? Number(string name)
        {
            if (!json.TryGetProperty(name, out var value)) return null;
            if (!value.TryGetDouble(out var number) || !double.IsFinite(number) || number is < 0 or > 1)
                throw new InvalidDataException("Input coordinates must be normalized.");
            return number;
        }
        var x = Number("x"); var y = Number("y");
        if ((x.HasValue != y.HasValue) || ((action is "move" or "down" or "up" or "wheel") && !x.HasValue)) throw new InvalidDataException("Input coordinates are incomplete.");
        int? button = null;
        if (json.TryGetProperty("button", out var buttonValue))
        {
            if (!buttonValue.TryGetInt32(out var number) || number is < 0 or > 2) throw new InvalidDataException("Invalid mouse button.");
            button = number;
        }
        if ((action is "down" or "up") && !button.HasValue) throw new InvalidDataException("Missing mouse button.");
        int? deltaY = null;
        if (json.TryGetProperty("deltaY", out var deltaValue))
        {
            if (!deltaValue.TryGetInt32(out var number) || number is < -1200 or > 1200) throw new InvalidDataException("Invalid wheel delta.");
            deltaY = number;
        }
        if (action == "wheel" && !deltaY.HasValue) throw new InvalidDataException("Missing wheel delta.");
        string? key = null;
        if (json.TryGetProperty("key", out var keyValue))
        {
            if (keyValue.ValueKind != JsonValueKind.String || !Keys.ContainsKey(keyValue.GetString() ?? "")) throw new InvalidDataException("Unsupported keyboard code.");
            key = keyValue.GetString();
        }
        if ((action is "keyDown" or "keyUp") && key is null) throw new InvalidDataException("Missing keyboard code.");
        return new SupportInput(action, x, y, button, deltaY, key);
    }

    private static IReadOnlyDictionary<string, ushort> BuildKeys()
    {
        var keys = new Dictionary<string, ushort>(StringComparer.Ordinal)
        {
            ["Enter"] = 0x0d, ["NumpadEnter"] = 0x0d, ["Escape"] = 0x1b, ["Backspace"] = 8, ["Tab"] = 9, ["Space"] = 0x20,
            ["Delete"] = 0x2e, ["Insert"] = 0x2d, ["Home"] = 0x24, ["End"] = 0x23, ["PageUp"] = 0x21, ["PageDown"] = 0x22,
            ["ArrowLeft"] = 0x25, ["ArrowUp"] = 0x26, ["ArrowRight"] = 0x27, ["ArrowDown"] = 0x28,
            ["ShiftLeft"] = 0xa0, ["ShiftRight"] = 0xa1, ["ControlLeft"] = 0xa2, ["ControlRight"] = 0xa3,
            ["AltLeft"] = 0xa4, ["AltRight"] = 0xa5, ["MetaLeft"] = 0x5b, ["MetaRight"] = 0x5c,
            ["CapsLock"] = 0x14, ["NumLock"] = 0x90, ["ScrollLock"] = 0x91,
            ["Minus"] = 0xbd, ["Equal"] = 0xbb, ["BracketLeft"] = 0xdb, ["BracketRight"] = 0xdd, ["Backslash"] = 0xdc,
            ["Semicolon"] = 0xba, ["Quote"] = 0xde, ["Backquote"] = 0xc0, ["Comma"] = 0xbc, ["Period"] = 0xbe, ["Slash"] = 0xbf,
            ["NumpadAdd"] = 0x6b, ["NumpadSubtract"] = 0x6d, ["NumpadMultiply"] = 0x6a, ["NumpadDivide"] = 0x6f, ["NumpadDecimal"] = 0x6e
        };
        for (var i = 0; i < 26; i++) keys["Key" + (char)('A' + i)] = (ushort)('A' + i);
        for (var i = 0; i < 10; i++) { keys["Digit" + i] = (ushort)('0' + i); keys["Numpad" + i] = (ushort)(0x60 + i); }
        for (var i = 1; i <= 12; i++) keys["F" + i] = (ushort)(0x6f + i);
        return keys;
    }
}

public static class SupportPipeFraming
{
    public static async Task<string?> ReadLineAsync(StreamReader reader, int maximumCharacters, CancellationToken ct)
    {
        var buffer = new char[1];
        var value = new System.Text.StringBuilder();
        while (await reader.ReadAsync(buffer.AsMemory(), ct) != 0)
        {
            if (buffer[0] == '\n')
            {
                // StreamWriter uses CRLF on Windows. The optional CR belongs to framing,
                // not to the payload budget; permit exactly one before the terminating LF.
                if (value.Length > 0 && value[^1] == '\r') value.Length--;
                if (value.Length > maximumCharacters) throw new InvalidDataException("Oversized support pipe message.");
                return value.ToString();
            }
            if (value.Length > maximumCharacters) throw new InvalidDataException("Oversized support pipe message.");
            value.Append(buffer[0]);
        }
        return value.Length == 0 ? null : throw new InvalidDataException("Incomplete support pipe message.");
    }
}
