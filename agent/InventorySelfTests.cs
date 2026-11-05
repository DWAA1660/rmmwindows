using System.Text.Json;

namespace LibraryRmm.Agent;

/// <summary>Inventory parsing/policy checks. Does not query LDAP, change registry or run repairs.</summary>
public static class InventorySelfTests
{
    public static async Task RunAsync()
    {
        Assert(InventoryDirectory.TimeoutSeconds == 5, "Domain discovery lost its hard process bound.");
        var escaped = InventoryDirectory.EscapeFilter("PC*)(\\\0é");
        Assert(escaped == "PC\\2a\\29\\28\\5c\\00\\c3\\a9", "LDAP filter escaping failed.");
        var script = InventoryDirectory.BuildScript("PC'*)(");
        Assert(script.Contains("sAMAccountName=PC''\\2a\\29\\28$", StringComparison.Ordinal) && !script.Contains("__LDAP_FILTER__", StringComparison.Ordinal), "LDAP/PowerShell literal escaping failed.");
        Assert(InventoryDirectory.OrganizationalUnits(@"CN=RESEARCH,OU=Computers,OU=Library,DC=example,DC=org").SequenceEqual(["Library", "Computers"]), "OU order is not root to leaf.");
        Assert(InventoryDirectory.OrganizationalUnits(@"CN=PC,OU=Adult\, Community,OU=North,DC=example,DC=org").SequenceEqual(["North", "Adult, Community"]), "Escaped DN comma split an OU.");
        Assert(InventoryDirectory.OrganizationalUnits(@"CN=PC,OU=R\C3\A9seau\2BArchives,OU=Library,DC=x").SequenceEqual(["Library", "Réseau+Archives"]), "UTF-8/plus DN escapes were not decoded.");
        Assert(InventoryDirectory.OrganizationalUnits("CN=PC,OU=\"One, Two\",DC=x").SequenceEqual(["One, Two"]), "Quoted DN comma failed.");
        Assert(InventoryDirectory.OrganizationalUnits(@"CN=PC,CN=Computers,DC=example,DC=org").Length == 0, "CN container was incorrectly called an OU.");
        Assert(InventoryDirectory.OrganizationalUnits(@"CN=PC,OU=North\\West,DC=x").SequenceEqual([@"North\West"]), "Escaped DN backslash failed.");
        var full = InventoryDirectory.ParseOutput("{\"domainController\":\"dc1.example.org\"}\n" +
            "{\"distinguishedName\":\"CN=PC,OU=Workstations,OU=Library,DC=example,DC=org\",\"canonicalName\":\"example.org/Library/Workstations/PC\",\"domainController\":\"dc1.example.org\",\"site\":\"Main\",\"error\":null}\n", false, false);
        Assert(full.OrganizationalUnits.SequenceEqual(["Library", "Workstations"]) && full.DomainController == "dc1.example.org" && full.Error is null, "Directory result lost valid fields.");
        var partial = InventoryDirectory.ParseOutput("{\"domainController\":\"dc1.example.org\"}\n{partial", true, true);
        Assert(partial.DomainController == "dc1.example.org" && partial.DistinguishedName is null && partial.Error!.Contains("timed out", StringComparison.Ordinal), "Timeout lost partial discovery or reported a false success.");
        var unavailable = InventoryDirectory.ParseOutput("", false, true);
        Assert(unavailable.Error is not null && unavailable.DomainController is null && unavailable.OrganizationalUnits.Length == 0, "Unavailable directory facts were invented.");
        var tooLong = InventoryDirectory.ParseOutput(JsonSerializer.Serialize(new { distinguishedName = "CN=PC,OU=" + new string('x', 800) + ",DC=x", domainController = new string('d', 600) }), false, false);
        Assert(tooLong.DomainController!.Length == 512 && tooLong.OrganizationalUnits[0].Length == 512 && tooLong.Error!.Contains("shortened", StringComparison.Ordinal), "Directory bounds were silent or not enforced.");

        if (OperatingSystem.IsWindows())
        {
            var directory = Path.Combine(Path.GetTempPath(), "library-rmm-inventory-parse-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                static string Literal(string text) => "'" + text.Replace("'", "''", StringComparison.Ordinal) + "'";
                var parse = "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseInput(" + Literal(InventoryCollector.Script) + ",[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw 'Base inventory syntax failed'};" +
                    "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseInput(" + Literal(InventoryDirectory.BuildScript("PC$")) + ",[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw 'Directory inventory syntax failed'};[Console]::Out.Write('syntax-ok')";
                var output = "";
                var result = await new PowerShellRunner().RunScriptAsync(parse, directory, (_, text) => { output += text; return Task.CompletedTask; }, 15, CancellationToken.None);
                Assert(result.ExitCode == 0 && !result.Interrupted && output.Contains("syntax-ok", StringComparison.Ordinal), "Windows PowerShell 5.1 rejected the actual inventory source.");
            }
            finally
            {
                var absolute = Path.GetFullPath(directory);
                var temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!absolute.StartsWith(temp, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(absolute).StartsWith("library-rmm-inventory-parse-", StringComparison.Ordinal)) throw new InvalidOperationException("Unsafe inventory-test cleanup target.");
                Directory.Delete(absolute, recursive: true);
            }
        }
        Console.WriteLine("PASS inventory LDAP escaping, OU hierarchy, bounded/partial discovery and real PowerShell syntax (no LDAP or repair operations)");
    }
    private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
