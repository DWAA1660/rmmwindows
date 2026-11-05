using System.Text.Json;

namespace LibraryRmm.Support;

/// <summary>WTSINFOEX_LEVEL1_W is 8-byte aligned: its SessionFlags is at byte16,
/// after Level/padding/SessionId/SessionState. State==Active is not the lock flag.</summary>
public static class SupportSessionFacts
{
    public static bool IsLockedInfo(ReadOnlySpan<byte> info) => info.Length >= 20 &&
        System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(info) == 1 &&
        System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(info[16..]) == 0;
}

public sealed record SupportGrant(string SessionId, string OperatorName, DateTimeOffset ExpiresAt, bool RequestedControl, string Credential,
    bool ApprovalRequired = true, int ApprovalSeconds = 15, bool ShowSessionDetails = true)
{
    public override string ToString() => $"Attended support session {SessionId}";
}

/// <summary>Sent once over the SYSTEM-only pipe to the screen helper; never a command-line or disk object.</summary>
/// <param name="SystemHelper">Agent 0.1.11+: the helper runs as SYSTEM in the target Windows session and follows its input
/// desktop, so the regular desktop, Ctrl+Alt+Delete, lock, sign-in and UAC screens are all shown and controlled.</param>
/// <param name="UserPresent">A user was signed in to that session when support started. Their own desktop is shown only
/// after the notice in their session approves (unless the administrator turned off both notice and indicator).</param>
/// <param name="UserName">DOMAIN\user of that signed-in user, reported as the consenting user.</param>
public sealed record SupportBootstrap(string ServerOrigin, SupportGrant Grant, int UserSessionId, int ServiceProcessId,
    bool SystemHelper = false, bool UserPresent = false, string? UserName = null)
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
            Grant.ApprovalSeconds is < 1 or > 300 || UserSessionId <= 0 || ServiceProcessId <= 0 ||
            (UserName is not null && (UserName.Length is 0 or > 200 || UserName.Any(char.IsControl))) || (UserPresent && UserName is null))
            throw new InvalidDataException("Invalid or expired support bootstrap.");
        return new UriBuilder(origin) { Scheme = "wss", Path = $"/api/support/{Grant.SessionId}/stream" }.Uri;
    }
    /// <summary>The administrator turned off both the approval notice and the sharing indicator for this session.</summary>
    public bool NoNotice => !Grant.ApprovalRequired && !Grant.ShowSessionDetails;
    public override string ToString() => $"Attended support bootstrap {Grant.SessionId}";
}

/// <summary>
/// Sent once over the SYSTEM+user pipe to the non-elevated notice in the signed-in user's session. It shows the
/// approve/decline notice, the sharing indicator and the emergency shortcut. It carries no relay credential:
/// the notice never touches the network, the screen or input.
/// </summary>
public sealed record SupportNoticeBootstrap(string SessionId, string OperatorName, DateTimeOffset ExpiresAt, bool RequestedControl,
    bool ApprovalRequired, int ApprovalSeconds, bool ShowSessionDetails, int UserSessionId, int ServiceProcessId)
{
    public static SupportNoticeBootstrap From(SupportGrant grant, int userSessionId, int serviceProcessId) => new(grant.SessionId, grant.OperatorName,
        grant.ExpiresAt, grant.RequestedControl, grant.ApprovalRequired, grant.ApprovalSeconds, grant.ShowSessionDetails, userSessionId, serviceProcessId);
    public void Validate(DateTimeOffset now)
    {
        if (!Guid.TryParseExact(SessionId, "D", out _) || string.IsNullOrWhiteSpace(OperatorName) || OperatorName.Length > 150 || OperatorName.Any(char.IsControl) ||
            ExpiresAt <= now || ExpiresAt > now.AddMinutes(31) || ApprovalSeconds is < 1 or > 300 || UserSessionId <= 0 || ServiceProcessId <= 0)
            throw new InvalidDataException("Invalid or expired support notice bootstrap.");
    }
    public override string ToString() => $"Attended support notice {SessionId}";
}

/// <summary>What the SYSTEM screen helper may show as the session's input desktop changes.</summary>
public static class SupportAccessPolicy
{
    public enum Step { Continue, Wait, NeedUserConsent }

    /// <param name="inputDesktop">Name of the session's input desktop ("Default", "Winlogon", ...), or null when the session is not attached to the console.</param>
    /// <param name="userSignedIn">Whether a user is signed in to the helper's Windows session.</param>
    /// <param name="locked">Whether Windows reports that session as locked.</param>
    /// <param name="userConsented">The signed-in user's notice approved (or its countdown ended) for this support session.</param>
    public static Step Decide(string? inputDesktop, bool userSignedIn, bool locked, bool userConsented, SupportGrant grant)
    {
        if (inputDesktop is null) return Step.Wait;
        // Nobody is signed in: only the Windows sign-in screen exists and there is no person to notify.
        if (!userSignedIn || userConsented || (!grant.ApprovalRequired && !grant.ShowSessionDetails)) return Step.Continue;
        // A locked session's lock/Ctrl+Alt+Delete screen shows none of the user's content, so the operator may unlock it.
        // An unlocked Winlogon desktop (a UAC prompt) shows a dimmed picture of the user's desktop and needs consent first.
        if (locked && !string.Equals(inputDesktop, "Default", StringComparison.OrdinalIgnoreCase)) return Step.Continue;
        return Step.NeedUserConsent;
    }
}

/// <summary>Strict line messages between the agent service and its helpers. Every line is bounded JSON with a fixed property set.</summary>
public static class SupportPipeMessages
{
    public const int MaximumLine = 512;
    public static readonly IReadOnlySet<string> Decisions = new HashSet<string>(StringComparer.Ordinal) { "manual", "automatic", "unattended" };
    /// <summary>Reasons the notice may give for ending support.</summary>
    public static readonly IReadOnlySet<string> NoticeStopReasons = new HashSet<string>(StringComparer.Ordinal)
        { "staff_declined", "staff_closed", "local_emergency_hotkey", "emergency_hotkey_unavailable", "session_expired" };

    public sealed record Message(string Type, JsonElement Body)
    {
        public bool Bool(string name) => Body.GetProperty(name).GetBoolean();
        public string Text(string name) => Body.GetProperty(name).GetString()!;
        public int Int(string name) => Body.GetProperty(name).GetInt32();
    }

    /// <summary>Parses one line whose "type" must be a key of <paramref name="shapes"/> and whose other properties are exactly that
    /// shape: "name:b" boolean, "name:s" short single-line string, "name:i" positive integer, "name:g" GUID string.</summary>
    public static Message Parse(string line, IReadOnlyDictionary<string, string> shapes)
    {
        if (line.Length > MaximumLine) throw new InvalidDataException("Oversized support pipe message.");
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeValue) || typeValue.ValueKind != JsonValueKind.String ||
            !shapes.TryGetValue(typeValue.GetString()!, out var shape)) throw new InvalidDataException("Unknown support pipe message.");
        var fields = shape.Length == 0 ? [] : shape.Split(',');
        if (root.EnumerateObject().Count() != fields.Length + 1) throw new InvalidDataException("Unexpected support pipe message fields.");
        foreach (var field in fields)
        {
            var parts = field.Split(':');
            if (!root.TryGetProperty(parts[0], out var value)) throw new InvalidDataException("Missing support pipe message field.");
            var valid = parts[1] switch
            {
                "b" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
                "s" => value.ValueKind == JsonValueKind.String && value.GetString()!.Length is > 0 and <= 200 && !value.GetString()!.Any(char.IsControl),
                "i" => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number > 0,
                "g" => value.ValueKind == JsonValueKind.String && Guid.TryParseExact(value.GetString(), "D", out _),
                _ => false
            };
            if (!valid) throw new InvalidDataException("Invalid support pipe message field.");
        }
        return new Message(typeValue.GetString()!, root.Clone());
    }

    /// <summary>Screen helper to service.</summary>
    public static readonly IReadOnlyDictionary<string, string> FromEngine = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["secureAttention"] = "requestId:g", ["controller"] = "connected:b", ["needNotice"] = ""
    };
    /// <summary>Notice to service. The service supplies the user name itself; the notice cannot claim one.</summary>
    public static readonly IReadOnlyDictionary<string, string> FromNotice = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["consent"] = "approved:b,control:b,decision:s", ["stop"] = "reason:s"
    };
    /// <summary>Service to screen helper.</summary>
    public static readonly IReadOnlyDictionary<string, string> ToEngine = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["secureAttentionResult"] = "requestId:g,success:b,message:s", ["notice"] = "pid:i", ["noticeClosed"] = "",
        ["userConsent"] = "approved:b,control:b,decision:s,userName:s", ["stop"] = "reason:s"
    };
    /// <summary>Service to notice.</summary>
    public static readonly IReadOnlyDictionary<string, string> ToNotice = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["controller"] = "connected:b"
    };
}

/// <summary>A rectangle of the encoded screen surface, in surface pixels.</summary>
public readonly record struct SupportRect(int X, int Y, int Width, int Height)
{
    public int Area => Width * Height;
}

/// <summary>
/// Agent 0.1.11 screen frames ("RMF1"). A keyframe repaints the whole surface; other frames patch only the rectangles
/// that changed, and a frame with no rectangles is a heartbeat. Layout (little-endian): "RMF1", seq u32, surface
/// width u16, height u16, flags u8 (bit0 keyframe), count u8, count x (x,y,w,h u16, jpegLength u32), then the JPEGs.
/// </summary>
public static class SupportFrameFormat
{
    public const int MaximumRects = 64;
    public static byte[] Build(uint seq, int width, int height, bool keyframe, IReadOnlyList<(SupportRect Rect, byte[] Jpeg)> parts)
    {
        if (width is < 1 or > 16000 || height is < 1 or > 16000 || parts.Count > MaximumRects || (keyframe && parts.Count == 0))
            throw new InvalidDataException("Invalid support frame.");
        var header = 14 + parts.Count * 12;
        var output = new byte[header + parts.Sum(part => part.Jpeg.Length)];
        "RMF1"u8.CopyTo(output);
        BitConverter.TryWriteBytes(output.AsSpan(4), seq);
        BitConverter.TryWriteBytes(output.AsSpan(8), (ushort)width);
        BitConverter.TryWriteBytes(output.AsSpan(10), (ushort)height);
        output[12] = keyframe ? (byte)1 : (byte)0;
        output[13] = (byte)parts.Count;
        var offset = header;
        for (var index = 0; index < parts.Count; index++)
        {
            var (rect, jpeg) = parts[index];
            if (rect.Width < 1 || rect.Height < 1 || rect.X < 0 || rect.Y < 0 || rect.X + rect.Width > width || rect.Y + rect.Height > height ||
                jpeg.Length < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8) throw new InvalidDataException("Invalid support frame rectangle.");
            var at = 14 + index * 12;
            BitConverter.TryWriteBytes(output.AsSpan(at), (ushort)rect.X);
            BitConverter.TryWriteBytes(output.AsSpan(at + 2), (ushort)rect.Y);
            BitConverter.TryWriteBytes(output.AsSpan(at + 4), (ushort)rect.Width);
            BitConverter.TryWriteBytes(output.AsSpan(at + 6), (ushort)rect.Height);
            BitConverter.TryWriteBytes(output.AsSpan(at + 8), jpeg.Length);
            jpeg.CopyTo(output, offset);
            offset += jpeg.Length;
        }
        return output;
    }

    /// <summary>
    /// Turns a grid of changed tiles into few rectangles: horizontal runs per tile row, merged downwards while a run
    /// matches exactly. Falls back to one bounding rectangle when there would be more than <paramref name="maximum"/>.
    /// </summary>
    public static List<SupportRect> Merge(bool[] dirty, int columns, int rows, int tile, int width, int height, int maximum = MaximumRects)
    {
        if (dirty.Length != columns * rows) throw new ArgumentException("Tile grid size mismatch.", nameof(dirty));
        var open = new List<(int Start, int End, int Top, int Bottom)>();
        var done = new List<(int Start, int End, int Top, int Bottom)>();
        for (var row = 0; row < rows; row++)
        {
            var runs = new List<(int Start, int End)>();
            for (var column = 0; column < columns; column++)
            {
                if (!dirty[row * columns + column]) continue;
                var start = column;
                while (column + 1 < columns && dirty[row * columns + column + 1]) column++;
                runs.Add((start, column));
            }
            var next = new List<(int Start, int End, int Top, int Bottom)>();
            foreach (var block in open)
            {
                var index = runs.FindIndex(run => run.Start == block.Start && run.End == block.End);
                if (index >= 0) { next.Add(block with { Bottom = row }); runs.RemoveAt(index); }
                else done.Add(block);
            }
            next.AddRange(runs.Select(run => (run.Start, run.End, row, row)));
            open = next;
        }
        done.AddRange(open);
        var rects = done.Select(block => Clip(block.Start * tile, block.Top * tile, (block.End - block.Start + 1) * tile, (block.Bottom - block.Top + 1) * tile, width, height)).ToList();
        if (rects.Count <= maximum) return rects;
        int left = rects.Min(rect => rect.X), top = rects.Min(rect => rect.Y);
        return [new SupportRect(left, top, rects.Max(rect => rect.X + rect.Width) - left, rects.Max(rect => rect.Y + rect.Height) - top)];
    }
    private static SupportRect Clip(int x, int y, int w, int h, int width, int height) => new(x, y, Math.Min(w, width - x), Math.Min(h, height - y));
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
public sealed class SupportPermissionGate(SupportNoticeBootstrap notice, Func<DateTimeOffset> clock, Func<bool> desktopAvailable, Func<bool>? controllerReady = null)
{
    public SupportPermissionGate(SupportBootstrap bootstrap, Func<DateTimeOffset> clock, Func<bool> desktopAvailable, Func<bool>? controllerReady = null)
        : this(SupportNoticeBootstrap.From(bootstrap.Grant, bootstrap.UserSessionId, bootstrap.ServiceProcessId), clock, desktopAvailable, controllerReady) { }
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
            if (approved || ended || clock() >= notice.ExpiresAt || !desktopAvailable()) return false;
            approved = true;
            control = allowControl && notice.RequestedControl;
            return true;
        }
    }
    public bool BeginLocalAccessPolicy()
    {
        lock (sync)
        {
            if (approved || ended || !desktopAvailable() || clock() >= notice.ExpiresAt) return false;
            localPolicyReadyAt ??= clock();
            return true;
        }
    }
    public bool ApproveAfterVisibleCountdown(bool allowControl)
    {
        lock (sync)
        {
            if (!notice.ApprovalRequired || !localPolicyReadyAt.HasValue || clock() - localPolicyReadyAt.Value < TimeSpan.FromSeconds(notice.ApprovalSeconds)) return false;
            return ApproveLocally(allowControl);
        }
    }
    public bool ApproveImmediatePolicy(bool allowControl)
    {
        lock (sync)
        {
            if (notice.ApprovalRequired || !localPolicyReadyAt.HasValue) return false;
            return ApproveLocally(allowControl);
        }
    }
    public void PauseLocally() { lock (sync) { if (approved && !ended) paused = true; } }
    public bool ResumeLocally()
    {
        lock (sync)
        {
            if (!approved || ended || clock() >= notice.ExpiresAt || !desktopAvailable()) return false;
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
            if (clock() >= notice.ExpiresAt) { ended = true; control = false; }
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
