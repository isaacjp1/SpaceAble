import RoomPlan
import SwiftUI
import WebKit

/// The SpaceAble website the app shows. Only pages from this host can open the scanner.
let siteURL = URL(string: "https://spaceable.vercel.app")! // placeholder until the site is deployed

/// The web view and its native side: the scanner bridge, links to other sites, and the microphone.
@MainActor
final class Site: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published var scanning = false
    @Published var message: String?

    override init() {
        let config = WKWebViewConfiguration()
        let handler = WeakScriptHandler()
        config.userContentController.add(handler, name: "scanRoom")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        handler.target = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.load(URLRequest(url: siteURL))
    }

    /// Page → app: the Scan room button.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == siteURL.host() else { return }
        guard RoomCaptureSession.isSupported else {
            self.message = "Room scanning needs an iPhone or iPad with a LiDAR scanner."
            return
        }
        scanning = true
    }

    /// App → page. The scan is passed as an argument, never spliced into the script.
    func importScan(_ room: CapturedRoom) async {
        do {
            let json = String(decoding: try JSONEncoder().encode(room), as: UTF8.self)
            let reply = try await webView.callAsyncJavaScript(
                "return window.spaceableImportScan ? window.spaceableImportScan(JSON.parse(scan)) : 'Update the SpaceAble website to import scans.'",
                arguments: ["scan": json], contentWorld: .page)
            message = reply as? String // nil on success
        } catch {
            message = "The scan couldn’t be opened: \(error.localizedDescription)"
        }
    }

    /// Links to other sites open in Safari.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == "https" || url.scheme == "http",
           url.host() != siteURL.host(), action.targetFrame?.isMainFrame ?? true {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    /// The site's voice input. iOS still asks once, with NSMicrophoneUsageDescription.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == siteURL.host() && type == .microphone ? .grant : .deny)
    }
}

/// WKUserContentController retains its handlers; this keeps it from retaining Site.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

struct SiteView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ webView: WKWebView, context: Context) {}
}
