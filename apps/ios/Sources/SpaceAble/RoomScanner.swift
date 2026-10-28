import RoomPlan
import SwiftUI

/// Apple's RoomPlan scanner. Calls `finish` with the processed room, or nil when cancelled.
struct RoomScanner: UIViewControllerRepresentable {
    let finish: @MainActor (CapturedRoom?) -> Void

    func makeUIViewController(context: Context) -> UINavigationController {
        UINavigationController(rootViewController: ScanController(finish: finish))
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}

final class ScanController: UIViewController, RoomCaptureViewDelegate {
    private let captureView = RoomCaptureView(frame: .zero)
    private let finish: @MainActor (CapturedRoom?) -> Void
    private var started = false
    private var stopped = false

    init(finish: @escaping @MainActor (CapturedRoom?) -> Void) {
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil } // RoomCaptureViewDelegate requires NSCoding; never decoded

    override func viewDidLoad() {
        super.viewDidLoad()
        captureView.frame = view.bounds
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        view.addSubview(captureView)
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.finish(nil) })
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "Done", primaryAction: UIAction { [weak self] _ in self?.stop() })
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return } // once: a share sheet closing must not restart it
        started = true
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stop()
    }

    /// RoomPlan then processes the scan and presents the result.
    private func stop() {
        guard started, !stopped else { return }
        stopped = true
        captureView.captureSession.stop()
        navigationItem.rightBarButtonItem = nil
    }

    nonisolated func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        true
    }

    nonisolated func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        let problem = error?.localizedDescription
        Task { @MainActor in self.show(processedResult, problem: problem) }
    }

    private func show(_ room: CapturedRoom, problem: String?) {
        if let problem {
            let alert = UIAlertController(title: "The scan didn’t work", message: problem, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in self?.finish(nil) })
            present(alert, animated: true)
            return
        }
        var items = [UIBarButtonItem(title: "Use this scan", primaryAction: UIAction { [weak self] _ in self?.finish(room) })]
        #if DEBUG
        items.append(UIBarButtonItem(title: "Share raw scan", primaryAction: UIAction { [weak self] _ in self?.share(room) }))
        #endif
        navigationItem.rightBarButtonItems = items
    }

    #if DEBUG
    /// Debug builds only: take a real scan off the phone, e.g. as a test fixture.
    private func share(_ room: CapturedRoom) {
        do {
            let url = FileManager.default.temporaryDirectory.appending(path: "room.json")
            try JSONEncoder().encode(room).write(to: url)
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItems?.last // iPad
            present(sheet, animated: true)
        } catch {
            let alert = UIAlertController(title: "Couldn’t save the scan", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: true)
        }
    }
    #endif
}
