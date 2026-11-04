using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>Read-only, bounded, approximate logical sizes. No file contents are read.</summary>
public static class StorageExplorer
{
    public static async Task InspectAsync(string path, Func<string, string, Task> output, CancellationToken ct)
    {
        var absolute = ValidateLocalPath(path);
        var root = new DirectoryInfo(absolute);
        if ((root.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("A reparse point cannot be used as the storage root.");
        var entries = new List<object>();
        var errors = new List<string>();
        var budget = new TraversalBudget(200_000, DateTimeOffset.UtcNow.AddSeconds(90));
        var partial = false;
        foreach (var entry in root.EnumerateFileSystemInfos())
        {
            ct.ThrowIfCancellationRequested();
            if (entries.Count >= 5000 || !budget.Take()) { partial = true; break; }
            var skipped = (entry.Attributes & FileAttributes.ReparsePoint) != 0;
            var isDirectory = (entry.Attributes & FileAttributes.Directory) != 0;
            long? size = null;
            var childErrors = new List<string>();
            var childPartial = false;
            try
            {
                if (!skipped)
                {
                    if (isDirectory) size = Measure((DirectoryInfo)entry, budget, childErrors, 0, ct, out childPartial);
                    else size = ((FileInfo)entry).Length;
                }
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
            {
                childErrors.Add($"{exception.GetType().Name}: {entry.FullName}");
                childPartial = true;
            }
            partial |= childPartial;
            entries.Add(new { name = entry.Name, path = entry.FullName, isDirectory, sizeBytes = size, skippedReparsePoint = skipped, partial = childPartial, errors = childErrors });
        }
        await output("stdout", JsonSerializer.Serialize(new
        {
            path = absolute, entries, partial = partial || budget.Exhausted, scannedEntries = budget.Visited,
            limitEntries = 200_000, maxRootEntries = 5000, maxDepth = 64,
            note = "Logical sizes; hard-linked files may be counted more than once. Reparse points and junctions are skipped. Access-denied paths are reported. No file contents are read.",
            errors
        }, AgentConfiguration.Json));
    }

    internal static string ValidateLocalPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 4096 || path.StartsWith("\\", StringComparison.Ordinal) || !Path.IsPathFullyQualified(path))
            throw new ArgumentException("Storage path must be an absolute local drive path, such as C:\\.");
        var absolute = Path.GetFullPath(path);
        if (absolute.Length < 3 || !char.IsAsciiLetter(absolute[0]) || absolute[1] != ':' || absolute[2] != '\\')
            throw new ArgumentException("Only local drive paths are supported.");
        // Disallow reparse points in every ancestor, rather than only the selected leaf.
        var current = new DirectoryInfo(absolute);
        while (current is not null)
        {
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Storage path must not traverse a reparse point or junction.");
            current = current.Parent;
        }
        return absolute;
    }

    private static long Measure(DirectoryInfo directory, TraversalBudget budget, List<string> errors, int depth, CancellationToken ct, out bool partial)
    {
        partial = false;
        if (depth >= 64) { partial = true; return 0; }
        long bytes = 0;
        try
        {
            foreach (var entry in directory.EnumerateFileSystemInfos())
            {
                ct.ThrowIfCancellationRequested();
                if (!budget.Take()) { partial = true; break; }
                try
                {
                    if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                    if (entry is DirectoryInfo child)
                    {
                        bytes += Measure(child, budget, errors, depth + 1, ct, out var childPartial);
                        partial |= childPartial;
                    }
                    else if (entry is FileInfo file) bytes += file.Length;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    AddError(errors, exception, entry.FullName);
                    partial = true;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            AddError(errors, exception, directory.FullName);
            partial = true;
        }
        return bytes;
    }

    private static void AddError(List<string> errors, Exception exception, string path)
    {
        if (errors.Count < 100) errors.Add($"{exception.GetType().Name}: {path}");
        else if (errors.Count == 100) errors.Add("Additional inaccessible paths omitted from this bounded storage report.");
    }
    private sealed class TraversalBudget(int remaining, DateTimeOffset deadline)
    {
        public int Visited { get; private set; }
        public bool Exhausted { get; private set; }
        public bool Take()
        {
            if (remaining <= 0 || DateTimeOffset.UtcNow > deadline) { Exhausted = true; return false; }
            remaining--; Visited++; return true;
        }
    }
}
