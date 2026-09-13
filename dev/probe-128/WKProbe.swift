import UIKit
import WebKit

/*
 * #128'S EXPERIMENT, WITH THE VARIABLE ISOLATED.
 *
 * Mobile Safari at http://localhost shows `mediaDevices`; chatterang at
 * capacitor://localhost does not. TWO things differ there — the scheme and the
 * host engine — so that pair cannot say which one matters.
 *
 * This loads the SAME probe into TWO WKWebViews in ONE app: one over
 * http://localhost:8128, one over a custom scheme served by a
 * WKURLSchemeHandler, which is exactly what `capacitor://` is. Same engine,
 * same process, same Info.plist, same secure-context status. The only
 * difference left is the scheme.
 *
 * Deliberately NO NSCameraUsageDescription, matching the shipping app, so a
 * missing usage string cannot be the hidden cause either.
 */

let PROBE_JS = """
JSON.stringify({
  href: location.href,
  protocol: location.protocol,
  isSecureContext: isSecureContext,
  mediaDevices: 'mediaDevices' in navigator,
  getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  BarcodeDetector: typeof BarcodeDetector !== 'undefined'
})
"""

/** Serves the probe page over a custom scheme, as Capacitor does. */
class SchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let html = "<!doctype html><meta charset=utf-8><title>probe</title><body>custom scheme</body>"
        let data = html.data(using: .utf8)!
        let response = URLResponse(url: task.request.url!, mimeType: "text/html",
                                   expectedContentLength: data.count, textEncodingName: "utf-8")
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

class VC: UIViewController {
    var httpWeb: WKWebView!
    var schemeWeb: WKWebView!
    let handler = SchemeHandler()
    var results: [String: String] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white

        let httpCfg = WKWebViewConfiguration()
        httpWeb = WKWebView(frame: .zero, configuration: httpCfg)
        httpWeb.load(URLRequest(url: URL(string: "http://localhost:8128/")!))

        let schemeCfg = WKWebViewConfiguration()
        schemeCfg.setURLSchemeHandler(handler, forURLScheme: "chatterang")
        schemeWeb = WKWebView(frame: .zero, configuration: schemeCfg)
        schemeWeb.load(URLRequest(url: URL(string: "chatterang://localhost/")!))

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.collect() }
    }

    func collect() {
        httpWeb.evaluateJavaScript(PROBE_JS) { v, e in
            self.results["http"] = (v as? String) ?? "ERROR \(String(describing: e))"
            self.schemeWeb.evaluateJavaScript(PROBE_JS) { v2, e2 in
                self.results["customScheme"] = (v2 as? String) ?? "ERROR \(String(describing: e2))"
                self.render()
            }
        }
    }

    func render() {
        let text = "WKWebView, one app, two origins\n\nhttp://localhost:8128\n\(results["http"] ?? "?")\n\nchatterang://localhost\n\(results["customScheme"] ?? "?")"
        print("WKPROBE_RESULT_BEGIN")
        print(text)
        print("WKPROBE_RESULT_END")
        let label = UILabel(frame: CGRect(x: 10, y: 70, width: view.bounds.width - 20, height: view.bounds.height - 100))
        label.numberOfLines = 0
        label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        label.textColor = .black
        label.text = text
        view.addSubview(label)
    }
}

class AD: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ a: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = VC()
        window?.makeKeyAndVisible()
        return true
    }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AD.self))
