import SwiftUI

struct ContentView: View {
    @StateObject private var site = Site()

    var body: some View {
        SiteView(webView: site.webView)
            .fullScreenCover(isPresented: $site.scanning) {
                RoomScanner { room in
                    site.scanning = false
                    if let room { Task { await site.importScan(room) } }
                }
                .ignoresSafeArea()
            }
            .alert("SpaceAble", isPresented: Binding(get: { site.message != nil }, set: { if !$0 { site.message = nil } })) {
                Button("OK") {}
            } message: {
                Text(site.message ?? "")
            }
    }
}
