using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;

namespace LibraryRmm.Agent;

/// <summary>Isolated files/fake HTTP only. Never launches an updater or modifies a service.</summary>
internal static class UpdateDiagnosticsTests
{
    internal static async Task RunAsync()
    {
        var root=Path.Combine(Path.GetTempPath(),"LibraryRmm-UpdateDiagnostics-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var config=new AgentConfiguration {ServerUrl="https://example.test",DeviceId=Guid.NewGuid().ToString(),AgentToken="test-only-not-logged",EndpointId=Guid.NewGuid().ToString(),DataDirectory=root};
            var now=DateTimeOffset.UtcNow;
            var state=new UpdateAttemptState("9.0.0",new string('a',64),1,now.AddMinutes(-15));
            UpdateDiagnostics.PublishReport(config,"installing","install",availableVersion:state.Version,packageSha256:state.Sha256,attemptState:state,now:now.AddMinutes(-15));
            Write(config,"update-state.json",state);
            var stalled=UpdateDiagnostics.Load(config);
            Assert(stalled.ErrorCode=="helper_stalled" && stalled.Phase=="retry_wait" && stalled.NextRetryAt>now,"Stalled helper/backoff was hidden.");
            File.WriteAllText(Path.Combine(root,"updates","update-9.0.0.log"),"sensitive-token-dont-report\nThe pipeline has been stopped.");
            var pipeline=UpdateDiagnostics.Load(config);
            // Reconstruct an older agent's evidence, which has no structured status yet.
            File.Delete(Path.Combine(root,"updates","update-status.json"));
            pipeline=UpdateDiagnostics.Load(config);
            Assert(pipeline.ErrorCode=="pipeline_stopped" && !JsonSerializer.Serialize(pipeline).Contains("sensitive-token"),"Legacy failure was not sanitized/reconciled.");
            Write(config,"update-result.json",new {schemaVersion=1,version="9.0.0",success=false,errorCode="install_failed",completedAt=now});
            Assert(UpdateDiagnostics.Load(config).ErrorCode=="install_failed","Helper result was not reconciled.");
            UpdateDiagnostics.PublishReport(config,"current","complete",availableVersion:AgentVersion.Value);
            Assert(UpdateDiagnostics.Load(config).Phase=="current","Actual installed version did not resolve helper outcome.");
            await AgentUpdater.TryBeginUpdateAsync(config with {AutoUpdate=false},NullLogger.Instance,CancellationToken.None);
            Assert(UpdateDiagnostics.Load(config with {AutoUpdate=false}).Phase=="disabled","Disabled update policy was not persisted.");

            var httpRoot=Path.Combine(root,"http");Directory.CreateDirectory(httpRoot);
            var httpConfig=config with {DataDirectory=httpRoot};
            using(var updater=new AgentUpdater(httpConfig,NullLogger.Instance,new FailureHandler()))
            {
                try{await updater.PrepareAsync(AgentVersion.Value,CancellationToken.None);throw new Exception("Expected fake HTTP failure.");}
                catch(AgentApiException){}
            }
            var http=UpdateDiagnostics.Load(httpConfig);
            Assert(http.ErrorCode=="http_error" && http.Stage=="manifest" && !JsonSerializer.Serialize(http).Contains("secret-response"),"Manifest failure leaked details or was omitted.");

            var badRoot=Path.Combine(root,"checksum");Directory.CreateDirectory(badRoot);
            var badConfig=config with {DataDirectory=badRoot};
            using(var updater=new AgentUpdater(badConfig,NullLogger.Instance,new PackageHandler()))
            {
                try{await updater.PrepareAsync(AgentVersion.Value,CancellationToken.None);throw new Exception("Expected checksum refusal.");}catch(InvalidDataException){}
                var bad=UpdateDiagnostics.Load(badConfig);
                Assert(bad.ErrorCode=="checksum_mismatch" && bad.Attempts==1 && bad.NextRetryAt>now,"Checksum attempt/retry evidence missing.");
                Assert(await updater.PrepareAsync(AgentVersion.Value,CancellationToken.None) is null,"Bad package was retried before backoff.");
                Assert(UpdateDiagnostics.Load(badConfig).ErrorCode=="retry_backoff","Backoff decision not reported.");
            }
            Assert(AgentUpdater.ErrorCode(new HttpRequestException(HttpRequestError.NameResolutionError,"secret-url"),"manifest")=="dns_error","DNS mapping failed.");
            Assert(AgentUpdater.ErrorCode(new HttpRequestException(HttpRequestError.SecureConnectionError,"secret-url"),"download")=="tls_error","TLS mapping failed.");
            Assert(AgentUpdater.ErrorCode(new TaskCanceledException("secret-url"),"download")=="request_timeout","Timeout mapping failed.");
            var helper=AgentUpdater.BuildHelperScript(new StagedUpdate("9.0.0",Path.Combine(root,"staged'quote")),Path.Combine(root,"LibraryRmm"),config);
            Assert(helper.Contains("update-result.json") && helper.Contains("[IO.File]::Replace") && helper.Contains("pipeline_stopped") && helper.Contains("staged''quote"),"Helper result or literal quoting contract failed.");
            Write(httpConfig,"update-status.json",new {schemaVersion=1,phase="failed",stage="manifest",summary="secret-response",errorCode="secret-token",installedVersion="malicious",attempts=99,checkedAt=now});
            var sanitized=UpdateDiagnostics.Load(httpConfig);
            Assert(sanitized.InstalledVersion==AgentVersion.Value && sanitized.Attempts==3 && !JsonSerializer.Serialize(sanitized).Contains("secret-"),"Persisted untrusted diagnostics leaked.");
        }
        finally
        {
            var full=Path.GetFullPath(root);
            if(!full.StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(full).StartsWith("LibraryRmm-UpdateDiagnostics-",StringComparison.Ordinal)) throw new IOException("Unsafe test cleanup target.");
            Directory.Delete(full,true);
        }
    }
    private static void Assert(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    private static void Write(AgentConfiguration config,string name,object value)
    {
        var updates=Path.Combine(config.DataDirectory,"updates");Directory.CreateDirectory(updates);
        File.WriteAllText(Path.Combine(updates,name),JsonSerializer.Serialize(value,AgentConfiguration.Json));
    }
    private sealed class FailureHandler:HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden){Content=new StringContent("secret-response-token")});
    }
    private sealed class PackageHandler:HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=request.RequestUri!.AbsolutePath is "/api/agent-download" or "/api/agent/update-manifest"
            ? JsonContent.Create(new AgentPackageManifest("9.0.0","win-x64",new string('b',64),4,AgentUpdater.DownloadPath),options:AgentConfiguration.Json)
            : new ByteArrayContent([1,2,3,4])});
    }
}
