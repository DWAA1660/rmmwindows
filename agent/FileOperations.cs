using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>Uploads the bytes of one downloaded file to the server for the current job.</summary>
public interface IFileTransfer
{
    Task UploadChunkAsync(long sequence, ReadOnlyMemory<byte> data, CancellationToken ct);
    Task FinishAsync(string name, long sizeBytes, string sha256, long chunks, CancellationToken ct);
}

/// <summary>Outcome of one <c>files</c> job: the JSON document written to stdout plus the job status.</summary>
public sealed record FileJobOutcome(string Json, string Status, int ExitCode, string Summary);

/// <summary>
/// Paths that remote file operations must never change. Reads (list/download) are allowed almost
/// everywhere; mutations are refused for drive roots, the Windows tree, the Program Files /
/// ProgramData / Users roots, and the agent's own install and data trees (which hold its
/// credential). Downloads and copies FROM the agent data tree are refused too.
/// </summary>
public sealed class FileSafetyPolicy
{
    private readonly string[] protectedTrees;   // the path and everything below it
    private readonly string[] protectedRoots;   // only the path itself (children may be changed)
    private readonly string[] secretTrees;      // never read remotely

    public FileSafetyPolicy(IEnumerable<string> protectedTrees, IEnumerable<string> protectedRoots, IEnumerable<string> secretTrees)
    {
        static string[] Normalize(IEnumerable<string> paths) => paths.Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path))).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        this.protectedTrees = Normalize(protectedTrees);
        this.protectedRoots = Normalize(protectedRoots);
        this.secretTrees = Normalize(secretTrees);
    }

    public static FileSafetyPolicy ForAgent(string dataDirectory)
    {
        static string Folder(Environment.SpecialFolder folder) => Environment.GetFolderPath(folder);
        var programFiles = Folder(Environment.SpecialFolder.ProgramFiles);
        var programData = Folder(Environment.SpecialFolder.CommonApplicationData);
        var windows = Folder(Environment.SpecialFolder.Windows);
        var systemDrive = Path.GetPathRoot(string.IsNullOrEmpty(windows) ? "C:\\" : windows) ?? "C:\\";
        var agentData = new[] { dataDirectory, Path.Combine(programData, "LibraryRmm") };
        return new FileSafetyPolicy(
            protectedTrees: [windows, Path.Combine(programFiles, "LibraryRmm"), AppContext.BaseDirectory, .. agentData],
            protectedRoots: [programFiles, Folder(Environment.SpecialFolder.ProgramFilesX86), programData,
                Path.Combine(systemDrive, "Users"), Path.Combine(systemDrive, "Program Files"), Path.Combine(systemDrive, "Program Files (x86)"), Path.Combine(systemDrive, "ProgramData")],
            secretTrees: agentData);
    }

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private static bool Inside(string path, string tree) => Same(path, tree) || path.StartsWith(tree + "\\", StringComparison.OrdinalIgnoreCase);

    /// <summary>Throws when <paramref name="path"/> (already validated and absolute) may not be changed.</summary>
    public void EnsureMutable(string path)
    {
        var target = Path.TrimEndingDirectorySeparator(path);
        if (Path.GetPathRoot(path) is { } root && Same(Path.TrimEndingDirectorySeparator(root), target))
            throw new UnauthorizedAccessException("Drive roots cannot be changed remotely.");
        foreach (var tree in protectedTrees)
        {
            if (Inside(target, tree)) throw new UnauthorizedAccessException($"{tree} is protected; files there cannot be changed remotely.");
            // Deleting or moving an ancestor would take the protected folder with it.
            if (Inside(tree, target)) throw new UnauthorizedAccessException($"{target} contains the protected folder {tree}.");
        }
        foreach (var folder in protectedRoots)
            if (Same(target, folder)) throw new UnauthorizedAccessException($"{folder} is a protected system folder and cannot be changed remotely.");
    }

    /// <summary>Destination folders: may be a drive root or Program Files, but never inside a protected tree.</summary>
    public void EnsureWritableDestination(string directory)
    {
        var target = Path.TrimEndingDirectorySeparator(directory);
        foreach (var tree in protectedTrees)
            if (Inside(target, tree)) throw new UnauthorizedAccessException($"{tree} is protected; files cannot be placed there remotely.");
    }

    public const string SecretMessage = "The agent's data folder holds its credential and cannot be read remotely.";

    public void EnsureReadable(string path)
    {
        if (!IsReadable(path)) throw new UnauthorizedAccessException(SecretMessage);
    }

    /// <summary>False for anything inside the agent data tree (also used to leave it out of folder zips).</summary>
    public bool IsReadable(string path)
    {
        var target = Path.TrimEndingDirectorySeparator(path);
        return !secretTrees.Any(tree => Inside(target, tree));
    }
}

/// <summary>Remote file explorer operations. Each call is one at-most-once job; nothing is retried.</summary>
public static class FileOperations
{
    public const long MaxDownloadBytes = 1L << 30;
    public const int TransferChunkBytes = 2 * 1024 * 1024;
    public const int MaxListEntries = 20_000;
    public const int MaxItems = 500;
    /// <summary>Folder downloads: most files/folders one zip may hold, and how many left-out items are listed.</summary>
    public const int MaxArchiveEntries = 100_000;
    public const int MaxSkippedListed = 500;
    /// <summary>Free space that must remain on the staging drive after the zip is built.</summary>
    public const long StagingReserveBytes = 512L * 1024 * 1024;
    private static readonly TimeSpan StaleStagingAge = TimeSpan.FromDays(1);
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };

    /// <param name="stagingDirectory">Where folder downloads build their temporary zip. The agent passes a
    /// folder inside its own data directory (SYSTEM/Administrators-only and never readable remotely).</param>
    public static async Task<FileJobOutcome> ExecuteAsync(JsonElement payload, FileSafetyPolicy policy, IFileTransfer? transfer, CancellationToken ct, string? stagingDirectory = null)
    {
        var action = payload.TryGetProperty("action", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
        try
        {
            return action switch
            {
                "list" => List(OptionalString(payload, "path"), ct),
                "delete" => Mutation(action, Batch(Paths(payload, "paths"), ct, path => Delete(path, Bool(payload, "recursive"), policy, ct))),
                "move" => Transfer(action, payload, policy, ct),
                "copy" => Transfer(action, payload, policy, ct),
                "rename" => Mutation(action, [Rename(String(payload, "path"), String(payload, "newName"), policy)]),
                "mkdir" => Mutation(action, [MakeDirectory(String(payload, "path"), policy)]),
                "download" => await DownloadAsync(String(payload, "path"), policy, transfer ?? throw new InvalidOperationException("File transfer is unavailable."), stagingDirectory, ct),
                _ => Failure(action, "Unsupported file action; nothing was changed.")
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception exception) when (exception is HttpRequestException or AgentApiException or TaskCanceledException)
        {
            return Failure(action, $"Sending the file to the server failed ({exception.Message}). Nothing was changed on the computer; create a new download to try again.");
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or UnauthorizedAccessException or InvalidDataException or InvalidOperationException or System.Security.SecurityException or NotSupportedException)
        {
            return Failure(action, exception.Message);
        }
    }

    private static FileJobOutcome Failure(string action, string message) =>
        new(JsonSerializer.Serialize(new { action, ok = false, error = message }, AgentConfiguration.Json), "failed", 1, Limit(message));

    private static string Limit(string text) => text.Length > 900 ? text[..900] : text;

    // ---------- validation ----------

    /// <summary>Absolute local drive path (X:\...), no UNC/device/ADS/wildcards/reserved names.</summary>
    internal static string ValidatePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 4096 || path.Contains('\0'))
            throw new ArgumentException("A path is required.");
        if (path.StartsWith('\\') || path.StartsWith('/') || path.Length < 3 || !char.IsAsciiLetter(path[0]) || path[1] != ':' || (path[2] != '\\' && path[2] != '/'))
            throw new ArgumentException($"Only absolute local drive paths such as C:\\Users are supported (not network or device paths): {path}");
        if (path.IndexOfAny(['*', '?', '"', '<', '>', '|']) >= 0 || path.IndexOf(':', 2) >= 0 || path.Any(char.IsControl))
            throw new ArgumentException($"The path contains characters that are not allowed: {path}");
        var absolute = Path.GetFullPath(path);
        if (absolute.Length < 3 || absolute[1] != ':' || absolute[2] != '\\' || absolute.StartsWith("\\\\", StringComparison.Ordinal))
            throw new ArgumentException("Only local drive paths are supported.");
        foreach (var segment in absolute[3..].Split('\\', StringSplitOptions.RemoveEmptyEntries))
            if (ReservedNames.Contains(segment.Split('.')[0].TrimEnd(' ')))
                throw new ArgumentException($"'{segment}' is a reserved Windows device name.");
        // Keep a trailing separator only for drive roots, so names and parents compute correctly.
        return absolute.Length > 3 ? Path.TrimEndingDirectorySeparator(absolute) : absolute;
    }

    internal static string ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 255 || name is "." or ".." || name.EndsWith('.') || name.EndsWith(' ') ||
            name.IndexOfAny(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) >= 0 || name.Any(char.IsControl))
            throw new ArgumentException("Names cannot be empty, end with a dot or space, or contain \\ / : * ? \" < > |.");
        if (ReservedNames.Contains(name.Split('.')[0].TrimEnd(' '))) throw new ArgumentException($"'{name}' is a reserved Windows device name.");
        return name;
    }

    private static string String(JsonElement payload, string property) =>
        payload.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new ArgumentException($"Missing {property}.");
    private static string OptionalString(JsonElement payload, string property) =>
        payload.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static bool Bool(JsonElement payload, string property) =>
        payload.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.True;
    private static string[] Paths(JsonElement payload, string property)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array || value.GetArrayLength() is < 1 or > MaxItems)
            throw new ArgumentException($"{property} must list 1 to {MaxItems} paths.");
        return value.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : "").ToArray();
    }

    private static bool IsLink(FileSystemInfo info) => (info.Attributes & FileAttributes.ReparsePoint) != 0;
    private static FileSystemInfo? Existing(string path)
    {
        var directory = new DirectoryInfo(path);
        if (directory.Exists) return directory;
        var file = new FileInfo(path);
        if (file.Exists) return file;
        // A dangling link still exists as an entry even though its target does not.
        return (file.Attributes != (FileAttributes)(-1) && file.LinkTarget is not null) ? file : null;
    }

    // ---------- list ----------

    private static FileJobOutcome List(string path, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(path))
        {
            var drives = DriveInfo.GetDrives().Select(drive =>
            {
                bool ready; string? label = null, format = null; long? total = null, free = null;
                try { ready = drive.IsReady; } catch (IOException) { ready = false; }
                if (ready)
                {
                    try { label = drive.VolumeLabel; format = drive.DriveFormat; total = drive.TotalSize; free = drive.AvailableFreeSpace; }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { ready = false; }
                }
                return new { name = drive.Name, label, type = drive.DriveType.ToString(), format, ready, totalBytes = total, freeBytes = free };
            }).ToArray();
            var json = JsonSerializer.Serialize(new { action = "list", ok = true, path = "", drives }, AgentConfiguration.Json);
            return new(json, "succeeded", 0, $"Listed {drives.Length} drive(s).");
        }
        var absolute = ValidatePath(path);
        var directory = new DirectoryInfo(absolute);
        if (!directory.Exists) throw new IOException(File.Exists(absolute) ? $"{absolute} is a file, not a folder." : $"Folder not found: {absolute}");
        var entries = new List<object>();
        var truncated = false;
        foreach (var entry in directory.EnumerateFileSystemInfos("*", new EnumerationOptions { IgnoreInaccessible = false, AttributesToSkip = 0, RecurseSubdirectories = false }))
        {
            ct.ThrowIfCancellationRequested();
            if (entries.Count >= MaxListEntries) { truncated = true; break; }
            var attributes = entry.Attributes;
            var isDirectory = (attributes & FileAttributes.Directory) != 0;
            entries.Add(new
            {
                name = entry.Name, path = entry.FullName, type = isDirectory ? "directory" : "file",
                size = isDirectory ? (long?)null : ((FileInfo)entry).Length,
                lastWriteTimeUtc = entry.LastWriteTimeUtc,
                hidden = (attributes & FileAttributes.Hidden) != 0, system = (attributes & FileAttributes.System) != 0,
                @readonly = (attributes & FileAttributes.ReadOnly) != 0, reparse = (attributes & FileAttributes.ReparsePoint) != 0
            });
        }
        var parent = directory.Parent?.FullName;
        var result = JsonSerializer.Serialize(new { action = "list", ok = true, path = absolute, parent, entries, truncated, maxEntries = MaxListEntries }, AgentConfiguration.Json);
        return new(result, "succeeded", 0, truncated ? $"Listed the first {MaxListEntries} entries of {absolute} (folder has more; listing is explicitly marked truncated)." : $"Listed {entries.Count} entries in {absolute}.");
    }

    // ---------- mutations ----------

    private sealed record ItemResult(string Path, bool Ok, string? Error = null, string? Target = null, string? Note = null);

    private static List<ItemResult> Batch(IEnumerable<string> paths, CancellationToken ct, Func<string, ItemResult> action)
    {
        var results = new List<ItemResult>();
        foreach (var path in paths.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            ct.ThrowIfCancellationRequested();
            try { results.Add(action(path)); }
            catch (OperationCanceledException) { throw; }
            catch (Exception exception) { results.Add(new ItemResult(path, false, exception.Message)); }
        }
        return results;
    }

    private static FileJobOutcome Mutation(string action, List<ItemResult> results)
    {
        var succeeded = results.Count(result => result.Ok);
        var failed = results.Count - succeeded;
        var json = JsonSerializer.Serialize(new
        {
            action, ok = failed == 0, succeeded, failed,
            results = results.Select(result => new { path = result.Path, ok = result.Ok, error = result.Error, target = result.Target, note = result.Note })
        }, AgentConfiguration.Json);
        var verb = action switch { "delete" => "deleted", "move" => "moved", "copy" => "copied", "rename" => "renamed", "mkdir" => "created", _ => "done" };
        var summary = failed == 0 ? $"{succeeded} item(s) {verb}." : $"{succeeded} item(s) {verb}, {failed} failed: {results.First(result => !result.Ok).Error}";
        return new(json, failed == 0 ? "succeeded" : "failed", failed == 0 ? 0 : 1, Limit(summary));
    }

    private static ItemResult Delete(string path, bool recursive, FileSafetyPolicy policy, CancellationToken ct)
    {
        var absolute = ValidatePath(path);
        policy.EnsureMutable(absolute);
        var info = Existing(absolute) ?? throw new FileNotFoundException($"Not found: {absolute}");
        if (IsLink(info))
        {
            // Remove the link itself; its target is never touched.
            if (info is DirectoryInfo) Directory.Delete(absolute, recursive: false); else File.Delete(absolute);
            return new ItemResult(absolute, true, Note: "Removed the link only; its target was not changed.");
        }
        if (info is FileInfo file)
        {
            ClearReadOnly(file);
            file.Delete();
            return new ItemResult(absolute, true);
        }
        if (!recursive && ((DirectoryInfo)info).EnumerateFileSystemInfos().Any())
            throw new IOException($"{absolute} is not empty. Choose a recursive delete to remove a folder and its contents.");
        var errors = new List<string>();
        DeleteTree((DirectoryInfo)info, errors, ct);
        if (errors.Count > 0)
            return new ItemResult(absolute, false, $"{errors.Count} item(s) could not be deleted (first: {errors[0]}). Everything else was removed.");
        return new ItemResult(absolute, true);
    }

    /// <summary>Depth-first delete that removes links as entries and never descends through them.</summary>
    private static void DeleteTree(DirectoryInfo directory, List<string> errors, CancellationToken ct)
    {
        IEnumerable<FileSystemInfo> children;
        try { children = directory.EnumerateFileSystemInfos().ToArray(); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { errors.Add($"{directory.FullName}: {exception.Message}"); return; }
        foreach (var child in children)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (IsLink(child))
                {
                    if (child is DirectoryInfo) Directory.Delete(child.FullName, recursive: false); else File.Delete(child.FullName);
                }
                else if (child is DirectoryInfo subdirectory) DeleteTree(subdirectory, errors, ct);
                else { ClearReadOnly((FileInfo)child); child.Delete(); }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { errors.Add($"{child.FullName}: {exception.Message}"); }
        }
        try
        {
            if ((directory.Attributes & FileAttributes.ReadOnly) != 0) directory.Attributes &= ~FileAttributes.ReadOnly;
            directory.Delete(recursive: false);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            if (errors.Count == 0) errors.Add($"{directory.FullName}: {exception.Message}");
        }
    }

    private static void ClearReadOnly(FileInfo file)
    {
        if (file.IsReadOnly) file.IsReadOnly = false;
    }

    private static FileJobOutcome Transfer(string action, JsonElement payload, FileSafetyPolicy policy, CancellationToken ct)
    {
        var destination = ValidatePath(String(payload, "destinationDirectory"));
        policy.EnsureWritableDestination(destination);
        if (!Directory.Exists(destination)) throw new DirectoryNotFoundException($"Destination folder not found: {destination}");
        var overwrite = Bool(payload, "overwrite");
        var results = Batch(Paths(payload, "sources"), ct, source => action == "move"
            ? Move(source, destination, overwrite, policy, ct)
            : Copy(source, destination, overwrite, policy, ct));
        return Mutation(action, results);
    }

    private static string ParentOf(string absolute) => Path.GetDirectoryName(absolute) ?? throw new IOException("A drive root has no parent folder.");
    private static bool IsSameOrInside(string path, string folder) =>
        string.Equals(path, folder, StringComparison.OrdinalIgnoreCase) || path.StartsWith(Path.TrimEndingDirectorySeparator(folder) + "\\", StringComparison.OrdinalIgnoreCase);

    private static ItemResult Move(string source, string destinationDirectory, bool overwrite, FileSafetyPolicy policy, CancellationToken ct)
    {
        var absolute = ValidatePath(source);
        policy.EnsureMutable(absolute);
        var info = Existing(absolute) ?? throw new FileNotFoundException($"Not found: {absolute}");
        var target = Path.Combine(destinationDirectory, info.Name);
        if (string.Equals(ParentOf(absolute), Path.TrimEndingDirectorySeparator(destinationDirectory), StringComparison.OrdinalIgnoreCase))
            return new ItemResult(absolute, true, Target: target, Note: "Already in this folder; nothing was changed.");
        if (info is DirectoryInfo && IsSameOrInside(destinationDirectory, absolute))
            throw new IOException($"Cannot move {absolute} into itself.");
        if (Existing(target) is { } existing)
        {
            if (!overwrite) throw new IOException($"{target} already exists.");
            if (existing is DirectoryInfo || info is DirectoryInfo) throw new IOException($"{target} already exists; folders are never replaced by a move. Delete it first.");
            policy.EnsureMutable(target);
        }
        if (info is DirectoryInfo directory)
        {
            var sameVolume = string.Equals(Path.GetPathRoot(absolute), Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase);
            if (sameVolume || IsLink(directory)) { Directory.Move(absolute, target); return new ItemResult(absolute, true, Target: target); }
            // Different drive: copy everything, then delete the source only if the copy was complete.
            var copyErrors = new List<string>(); var skipped = new List<string>();
            CopyTree(directory, target, overwrite: false, copyErrors, skipped, ct);
            if (copyErrors.Count > 0)
                return new ItemResult(absolute, false, $"Copied with {copyErrors.Count} error(s) (first: {copyErrors[0]}); the original was kept.", target);
            var deleteErrors = new List<string>();
            DeleteTree(directory, deleteErrors, ct);
            return deleteErrors.Count > 0
                ? new ItemResult(absolute, false, $"Copied, but {deleteErrors.Count} original item(s) could not be removed (first: {deleteErrors[0]}).", target)
                : new ItemResult(absolute, true, Target: target, Note: skipped.Count > 0 ? $"{skipped.Count} link(s) inside were not copied: {skipped[0]}" : null);
        }
        File.Move(absolute, target, overwrite);
        return new ItemResult(absolute, true, Target: target);
    }

    private static ItemResult Copy(string source, string destinationDirectory, bool overwrite, FileSafetyPolicy policy, CancellationToken ct)
    {
        var absolute = ValidatePath(source);
        policy.EnsureReadable(absolute);
        var info = Existing(absolute) ?? throw new FileNotFoundException($"Not found: {absolute}");
        if (IsLink(info)) throw new IOException($"{absolute} is a link (symbolic link or junction); links are never followed when copying.");
        if (info is DirectoryInfo && (Path.GetPathRoot(absolute) is { } root && string.Equals(root, absolute, StringComparison.OrdinalIgnoreCase)))
            throw new UnauthorizedAccessException("A whole drive cannot be copied.");
        var target = Path.Combine(destinationDirectory, info.Name);
        string? note = null;
        if (string.Equals(target, absolute, StringComparison.OrdinalIgnoreCase))
        {
            // Pasting into the same folder makes "name - Copy", like Explorer.
            target = UniqueCopyName(destinationDirectory, info);
            note = $"Pasted into the same folder as {Path.GetFileName(target)}.";
        }
        if (info is DirectoryInfo directory)
        {
            if (IsSameOrInside(destinationDirectory, absolute)) throw new IOException($"Cannot copy {absolute} into itself.");
            if (Existing(target) is { } existing && (!overwrite || existing is not DirectoryInfo))
                throw new IOException($"{target} already exists.");
            var errors = new List<string>(); var skipped = new List<string>();
            CopyTree(directory, target, overwrite, errors, skipped, ct);
            if (skipped.Count > 0) note = $"{skipped.Count} link(s) inside were not copied (links are never followed): {skipped[0]}";
            return errors.Count > 0
                ? new ItemResult(absolute, false, $"{errors.Count} item(s) could not be copied (first: {errors[0]}). The rest were copied.", target, note)
                : new ItemResult(absolute, true, Target: target, Note: note);
        }
        if (Existing(target) is DirectoryInfo) throw new IOException($"A folder named {target} already exists.");
        if (File.Exists(target) && !overwrite) throw new IOException($"{target} already exists.");
        File.Copy(absolute, target, overwrite);
        return new ItemResult(absolute, true, Target: target, Note: note);
    }

    private static string UniqueCopyName(string directory, FileSystemInfo info)
    {
        var isDirectory = info is DirectoryInfo;
        var stem = isDirectory ? info.Name : Path.GetFileNameWithoutExtension(info.Name);
        var extension = isDirectory ? "" : Path.GetExtension(info.Name);
        for (var index = 1; index < 1000; index++)
        {
            var candidate = Path.Combine(directory, $"{stem} - Copy{(index == 1 ? "" : $" ({index})")}{extension}");
            if (Existing(candidate) is null) return candidate;
        }
        throw new IOException("Could not find a free name for the copy.");
    }

    /// <summary>Recursive copy that skips (and reports) links instead of following them.</summary>
    private static void CopyTree(DirectoryInfo source, string target, bool overwrite, List<string> errors, List<string> skipped, CancellationToken ct)
    {
        try { Directory.CreateDirectory(target); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { errors.Add($"{target}: {exception.Message}"); return; }
        IEnumerable<FileSystemInfo> children;
        try { children = source.EnumerateFileSystemInfos().ToArray(); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { errors.Add($"{source.FullName}: {exception.Message}"); return; }
        foreach (var child in children)
        {
            ct.ThrowIfCancellationRequested();
            var destination = Path.Combine(target, child.Name);
            try
            {
                if (IsLink(child)) { skipped.Add(child.FullName); continue; }
                if (child is DirectoryInfo directory) CopyTree(directory, destination, overwrite, errors, skipped, ct);
                else
                {
                    if (!overwrite && File.Exists(destination)) { errors.Add($"{destination}: already exists."); continue; }
                    ((FileInfo)child).CopyTo(destination, overwrite);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { errors.Add($"{child.FullName}: {exception.Message}"); }
        }
    }

    private static ItemResult Rename(string path, string newName, FileSafetyPolicy policy)
    {
        var absolute = ValidatePath(path);
        policy.EnsureMutable(absolute);
        var name = ValidateName(newName);
        var info = Existing(absolute) ?? throw new FileNotFoundException($"Not found: {absolute}");
        var target = Path.Combine(ParentOf(absolute), name);
        policy.EnsureMutable(target);
        if (string.Equals(target, absolute, StringComparison.Ordinal)) return new ItemResult(absolute, true, Target: target, Note: "The name did not change.");
        var caseOnly = string.Equals(target, absolute, StringComparison.OrdinalIgnoreCase);
        if (!caseOnly && Existing(target) is not null) throw new IOException($"{target} already exists.");
        void MoveEntry(string from, string to)
        {
            if (info is DirectoryInfo) Directory.Move(from, to); else File.Move(from, to);
        }
        if (caseOnly)
        {
            // Windows names are case-insensitive: go through a temporary name to change only the case.
            var temporary = Path.Combine(ParentOf(absolute), $".rmm-rename-{Guid.NewGuid():N}");
            MoveEntry(absolute, temporary);
            MoveEntry(temporary, target);
        }
        else MoveEntry(absolute, target);
        return new ItemResult(absolute, true, Target: target);
    }

    private static ItemResult MakeDirectory(string path, FileSafetyPolicy policy)
    {
        var absolute = ValidatePath(path);
        policy.EnsureMutable(absolute);
        ValidateName(Path.GetFileName(absolute));
        var parent = ParentOf(absolute);
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException($"Parent folder not found: {parent}");
        if (Existing(absolute) is not null) throw new IOException($"{absolute} already exists.");
        Directory.CreateDirectory(absolute);
        return new ItemResult(absolute, true);
    }

    // ---------- download ----------

    private static async Task<FileJobOutcome> DownloadAsync(string path, FileSafetyPolicy policy, IFileTransfer transfer, string? stagingDirectory, CancellationToken ct)
    {
        var absolute = ValidatePath(path);
        policy.EnsureReadable(absolute);
        if (Directory.Exists(absolute)) return await DownloadFolderAsync(absolute, policy, transfer, stagingDirectory, ct);
        var info = new FileInfo(absolute);
        if (!info.Exists) throw new FileNotFoundException($"File not found: {absolute}");
        if (IsLink(info)) throw new IOException($"{absolute} is a link; links are never followed for downloads.");
        if (info.Length > MaxDownloadBytes) throw new IOException($"{absolute} is {info.Length:N0} bytes; the download limit is {MaxDownloadBytes:N0} bytes.");
        var (total, sha256, chunks) = await UploadAsync(absolute, info.Name, transfer, ct);
        var json = JsonSerializer.Serialize(new { action = "download", ok = true, path = absolute, name = info.Name, size = total, sha256, chunks, archive = false }, AgentConfiguration.Json);
        return new(json, "succeeded", 0, $"Uploaded {info.Name} ({total:N0} bytes, SHA-256 {sha256[..12]}…) to the server.");
    }

    /// <summary>Streams one local file to the server in fixed-size chunks; returns its size, SHA-256 and chunk count.</summary>
    private static async Task<(long Total, string Sha256, long Chunks)> UploadAsync(string file, string name, IFileTransfer transfer, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[TransferChunkBytes];
        long total = 0, sequence = 0;
        // Share read/write/delete so files in use (logs) can still be read.
        await using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, FileOptions.SequentialScan | FileOptions.Asynchronous))
        {
            while (true)
            {
                var filled = 0;
                while (filled < buffer.Length)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(filled), ct);
                    if (read == 0) break;
                    filled += read;
                }
                if (filled == 0) break;
                total += filled;
                if (total > MaxDownloadBytes) throw new IOException($"{file} grew beyond the {MaxDownloadBytes:N0}-byte download limit while it was read.");
                hash.AppendData(buffer, 0, filled);
                await transfer.UploadChunkAsync(sequence++, buffer.AsMemory(0, filled), ct);
                if (filled < buffer.Length) break;
            }
        }
        var sha256 = Convert.ToHexStringLower(hash.GetHashAndReset());
        await transfer.FinishAsync(name, total, sha256, sequence, ct);
        return (total, sha256, sequence);
    }

    // ---------- folder download (zip) ----------

    private sealed record ArchiveItem(string FullPath, string EntryName, bool IsDirectory, DateTime LastWriteTime);
    private sealed record SkippedItem(string Path, string Error);

    /// <summary>
    /// Compresses a folder into one zip whose top-level entry is the folder itself (like Explorer's
    /// "Compressed (zipped) folder"), then uploads it exactly like a single file. The zip is built in the
    /// staging folder and always deleted afterwards. Links are never followed and the agent data tree is
    /// never included; those, and files that cannot be opened (in use, access denied), are left out and
    /// listed in the result. A file that fails part-way through reading fails the whole job, so a zip
    /// never contains a silently truncated file.
    /// </summary>
    private static async Task<FileJobOutcome> DownloadFolderAsync(string folder, FileSafetyPolicy policy, IFileTransfer transfer, string? stagingDirectory, CancellationToken ct)
    {
        var root = new DirectoryInfo(folder);
        if (IsLink(root)) throw new IOException($"{folder} is a link (symbolic link or junction); links are never followed for downloads.");
        if (Path.GetPathRoot(folder) is { } driveRoot && string.Equals(driveRoot, folder, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("A whole drive cannot be downloaded; open it and download individual folders.");
        var staging = Path.TrimEndingDirectorySeparator(Path.GetFullPath(stagingDirectory ?? Path.Combine(Path.GetTempPath(), "LibraryRmm-download-staging")));
        if (IsSameOrInside(folder, staging)) throw new UnauthorizedAccessException("The agent's temporary download folder cannot be downloaded.");

        var skipped = new List<SkippedItem>();
        var items = CollectArchiveItems(root, policy, staging, skipped, ct);
        var folderCount = items.Count(item => item.IsDirectory);
        long sourceBytes = 0;
        foreach (var item in items.Where(item => !item.IsDirectory))
            try { sourceBytes += new FileInfo(item.FullPath).Length; } catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }

        Directory.CreateDirectory(staging);
        RemoveStaleStagingFiles(staging);
        var drive = new DriveInfo(Path.GetPathRoot(staging)!);
        var needed = Math.Min(sourceBytes, MaxDownloadBytes) + StagingReserveBytes;
        if (drive.AvailableFreeSpace < needed)
            throw new IOException($"Not enough free space on {drive.Name} to build the zip: {drive.AvailableFreeSpace:N0} bytes free, {needed:N0} needed (the zip plus a {StagingReserveBytes / (1024 * 1024)} MiB safety margin). Nothing was sent.");

        var name = ArchiveName(root.Name);
        var archivePath = Path.Combine(staging, $"{Guid.NewGuid():N}.zip.partial");
        try
        {
            var included = await WriteArchiveAsync(archivePath, items, skipped, ct);
            var (total, sha256, chunks) = await UploadAsync(archivePath, name, transfer, ct);
            var json = JsonSerializer.Serialize(new
            {
                action = "download", ok = true, path = folder, name, size = total, sha256, chunks, archive = true,
                files = included, folders = folderCount, sourceBytes,
                skippedCount = skipped.Count,
                skipped = skipped.Take(MaxSkippedListed).Select(item => new { path = item.Path, error = item.Error }),
                skippedListTruncated = skipped.Count > MaxSkippedListed
            }, AgentConfiguration.Json);
            var summary = $"Compressed {folder} ({included:N0} file(s), {folderCount:N0} folder(s), {sourceBytes:N0} bytes) into {name} ({total:N0} bytes, SHA-256 {sha256[..12]}…) and uploaded it to the server.";
            if (skipped.Count > 0) summary += $" {skipped.Count:N0} item(s) were left out (first: {skipped[0].Path} — {skipped[0].Error}); the job output lists them.";
            return new(json, "succeeded", 0, Limit(summary));
        }
        finally
        {
            try { File.Delete(archivePath); } catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { /* removed by the next stale sweep */ }
        }
    }

    /// <summary>Walks the tree without following links: folders (as "name/" entries) and files, in name order.</summary>
    private static List<ArchiveItem> CollectArchiveItems(DirectoryInfo root, FileSafetyPolicy policy, string staging, List<SkippedItem> skipped, CancellationToken ct)
    {
        var items = new List<ArchiveItem>();
        var pending = new Stack<(DirectoryInfo Directory, string EntryName)>();
        pending.Push((root, root.Name));
        var options = new EnumerationOptions { IgnoreInaccessible = false, AttributesToSkip = 0, RecurseSubdirectories = false };
        while (pending.Count > 0)
        {
            ct.ThrowIfCancellationRequested();
            var (directory, entryName) = pending.Pop();
            items.Add(new ArchiveItem(directory.FullName, entryName, true, directory.LastWriteTime));
            FileSystemInfo[] children;
            try { children = directory.EnumerateFileSystemInfos("*", options).OrderBy(child => child.Name, StringComparer.OrdinalIgnoreCase).ToArray(); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Security.SecurityException)
            {
                skipped.Add(new SkippedItem(directory.FullName, $"Folder contents could not be read: {exception.Message}"));
                continue;
            }
            var subdirectories = new List<(DirectoryInfo, string)>();
            foreach (var child in children)
            {
                // Our own temporary zip is not user data; leave it out without listing it.
                if (IsSameOrInside(child.FullName, staging)) continue;
                if (!policy.IsReadable(child.FullName)) { skipped.Add(new SkippedItem(child.FullName, FileSafetyPolicy.SecretMessage)); continue; }
                if (IsLink(child)) { skipped.Add(new SkippedItem(child.FullName, "Link (symbolic link or junction); links are never followed.")); continue; }
                var childEntry = $"{entryName}/{child.Name}";
                if (child is DirectoryInfo subdirectory) subdirectories.Add((subdirectory, childEntry));
                else items.Add(new ArchiveItem(child.FullName, childEntry, false, child.LastWriteTime));
                if (items.Count + subdirectories.Count + pending.Count > MaxArchiveEntries)
                    throw new IOException($"{root.FullName} holds more than {MaxArchiveEntries:N0} files and folders; download smaller folders instead. Nothing was sent.");
            }
            // Pushed in reverse so subfolders are visited in name order.
            for (var index = subdirectories.Count - 1; index >= 0; index--) pending.Push(subdirectories[index]);
        }
        return items;
    }

    /// <summary>Writes the zip; returns how many files went in. Files that cannot be opened are added to <paramref name="skipped"/>.</summary>
    private static async Task<int> WriteArchiveAsync(string archivePath, List<ArchiveItem> items, List<SkippedItem> skipped, CancellationToken ct)
    {
        var buffer = new byte[1024 * 1024];
        var included = 0;
        await using var output = new FileStream(archivePath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920);
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var item in items)
            {
                ct.ThrowIfCancellationRequested();
                if (item.IsDirectory)
                {
                    zip.CreateEntry(item.EntryName + "/").LastWriteTime = ZipTime(item.LastWriteTime);
                    continue;
                }
                FileStream source;
                try { source = new FileStream(item.FullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, FileOptions.SequentialScan | FileOptions.Asynchronous); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Security.SecurityException)
                {
                    // Not opened, so nothing of it is in the zip: list it instead of failing the whole folder.
                    skipped.Add(new SkippedItem(item.FullPath, exception.Message));
                    continue;
                }
                await using (source)
                {
                    var entry = zip.CreateEntry(item.EntryName, CompressionLevel.Optimal);
                    entry.LastWriteTime = ZipTime(item.LastWriteTime);
                    await using var target = entry.Open();
                    while (true)
                    {
                        int read;
                        try { read = await source.ReadAsync(buffer, ct); }
                        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                        {
                            throw new IOException($"{item.FullPath} could not be read completely ({exception.Message}). The zip was discarded and nothing was sent.", exception);
                        }
                        if (read == 0) break;
                        await target.WriteAsync(buffer.AsMemory(0, read), ct);
                        if (output.Position > MaxDownloadBytes) throw TooLarge();
                    }
                }
                included++;
            }
        }
        if (output.Length > MaxDownloadBytes) throw TooLarge();
        return included;

        static IOException TooLarge() => new($"The zip grew beyond the {MaxDownloadBytes:N0}-byte download limit; download smaller folders instead. Nothing was sent.");
    }

    /// <summary>Zip timestamps only cover 1980–2107.</summary>
    private static DateTimeOffset ZipTime(DateTime local)
    {
        var minimum = new DateTime(1980, 1, 1, 0, 0, 0, DateTimeKind.Local);
        var maximum = new DateTime(2107, 12, 31, 23, 59, 58, DateTimeKind.Local);
        return new DateTimeOffset(local < minimum ? minimum : local > maximum ? maximum : local);
    }

    /// <summary>"Folder" -> "Folder.zip", kept within the server's 255-character name limit.</summary>
    internal static string ArchiveName(string folderName)
    {
        var stem = folderName.TrimEnd('.', ' ');
        if (stem.Length > 251) stem = stem[..251].TrimEnd('.', ' ');
        return (stem.Length == 0 ? "folder" : stem) + ".zip";
    }

    private static void RemoveStaleStagingFiles(string staging)
    {
        foreach (var file in new DirectoryInfo(staging).EnumerateFiles("*.zip.partial"))
            try { if (DateTime.UtcNow - file.LastWriteTimeUtc > StaleStagingAge) file.Delete(); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
    }
}
