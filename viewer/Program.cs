using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PetrelViewer;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new ViewerWindow());
    }
}

internal sealed class ViewerWindow : Form
{
    private const string Origin = "https://petrel-viewer.example";
    private const string SecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "connect-src 'self'; worker-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

    private sealed record Sample(string File, string Label, string Detail);

    private static readonly Sample[] Samples =
    [
        new("ach_code5_main_body.stl", "Ачимовский пробник", "Связное тело · код 5"),
        new("ach_code5.stl", "Ачимовский интервал", "Полная выборка · код 5"),
        new("jurasic_code5.stl", "Юрский интервал", "Полная выборка · код 5"),
        new("mel_code5.stl", "Меловой интервал", "Полная выборка · код 5"),
    ];

    private static readonly Dictionary<string, (string File, string Mime)> Assets = new()
    {
        ["/"] = ("index.html", "text/html; charset=utf-8"),
        ["/styles.css"] = ("styles.css", "text/css; charset=utf-8"),
        ["/viewer.js"] = ("viewer.js", "text/javascript; charset=utf-8"),
        ["/renderer.js"] = ("renderer.js", "text/javascript; charset=utf-8"),
        ["/mesh-worker.js"] = ("mesh-worker.js", "text/javascript; charset=utf-8"),
    };

    private readonly WebView2 webView = new()
    {
        Dock = DockStyle.Fill,
        DefaultBackgroundColor = Color.FromArgb(20, 25, 33),
    };

    private readonly Dictionary<string, string> samplePaths = FindSamples();

    internal ViewerWindow()
    {
        Text = "Petrel STL — просмотр моделей";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1240, 790);
        MinimumSize = new Size(680, 540);
        BackColor = webView.DefaultBackgroundColor;
        Controls.Add(webView);
        Shown += async (_, _) => await StartViewerAsync();
    }

    private async Task StartViewerAsync()
    {
        try
        {
            string localState = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PetrelViewer", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: localState);
            await webView.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;

            CoreWebView2 browser = webView.CoreWebView2;
            browser.Settings.AreBrowserAcceleratorKeysEnabled = false;
            browser.Settings.AreDefaultContextMenusEnabled = false;
            browser.Settings.IsStatusBarEnabled = false;
            browser.Settings.IsWebMessageEnabled = false;
            browser.NavigationStarting += (_, args) =>
            {
                args.Cancel = !Uri.TryCreate(args.Uri, UriKind.Absolute, out var target) ||
                    target.GetLeftPart(UriPartial.Authority) != Origin;
            };
            browser.NewWindowRequested += (_, args) => args.Handled = true;
            browser.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All,
                CoreWebView2WebResourceRequestSourceKinds.All);
            browser.WebResourceRequested += ServeResource;
            browser.Navigate(Origin + "/");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowStartupError("Для запуска нужен Microsoft Edge WebView2 Runtime.");
        }
        catch (Exception error)
        {
            ShowStartupError("Не удалось запустить просмотрщик. " + error.Message);
        }
    }

    private void ShowStartupError(string message)
    {
        if (IsDisposed) return;
        MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }

    private void ServeResource(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        string path = new Uri(args.Request.Uri).AbsolutePath;
        try
        {
            if (args.Request.Method != "GET")
            {
                args.Response = Response(Stream.Null, "text/plain", 405, "Method Not Allowed");
            }
            else if (Assets.TryGetValue(path, out var asset))
            {
                Stream stream = typeof(ViewerWindow).Assembly.GetManifestResourceStream("PetrelViewer.Web." + asset.File)
                    ?? throw new InvalidOperationException("Viewer resource missing: " + asset.File);
                args.Response = Response(stream, asset.Mime);
            }
            else if (path == "/samples.json")
            {
                var available = Samples.Where(sample => samplePaths.ContainsKey(sample.File));
                byte[] json = JsonSerializer.SerializeToUtf8Bytes(available, JsonSerializerOptions.Web);
                args.Response = Response(new MemoryStream(json), "application/json; charset=utf-8");
            }
            else if (path.StartsWith("/samples/", StringComparison.Ordinal) &&
                     samplePaths.TryGetValue(path[9..], out var file))
            {
                // WebView2 reads this stream asynchronously after the event returns.
                Stream model = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read,
                    bufferSize: 65536, FileOptions.SequentialScan);
                args.Response = Response(model, "application/octet-stream");
            }
            else
            {
                args.Response = Response(Stream.Null, "text/plain", 404, "Not Found");
            }
        }
        catch (IOException)
        {
            args.Response = Response(Stream.Null, "text/plain", 404, "Not Found");
        }
        catch (UnauthorizedAccessException)
        {
            args.Response = Response(Stream.Null, "text/plain", 403, "Forbidden");
        }
    }

    private CoreWebView2WebResourceResponse Response(Stream stream, string mime, int status = 200, string reason = "OK")
    {
        string headers = $"Content-Type: {mime}\r\nContent-Length: {stream.Length}\r\n" +
            $"Content-Security-Policy: {SecurityPolicy}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store";
        return webView.CoreWebView2.Environment.CreateWebResourceResponse(stream, status, reason, headers);
    }

    private static Dictionary<string, string> FindSamples()
    {
        var available = new Dictionary<string, string>(StringComparer.Ordinal);
        for (DirectoryInfo? parent = new(AppContext.BaseDirectory); parent is not null; parent = parent.Parent)
        {
            foreach (Sample model in Samples)
            {
                string candidate = Path.Combine(parent.FullName, "STL", model.File);
                if (File.Exists(candidate)) available.TryAdd(model.File, candidate);
            }
            if (available.Count == Samples.Length) break;
        }
        return available;
    }
}
