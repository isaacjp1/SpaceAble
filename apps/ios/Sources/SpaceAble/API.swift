import Foundation
import RoomPlan

/// The SpaceAble web app, which runs the planner. Set `SpaceAbleServer` in Info.plist to use another
/// one, e.g. a dev server on the local network.
let serverURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "SpaceAbleServer") as? String ?? "")
    ?? URL(string: "https://spaceable.vercel.app")!

struct Room: Decodable, Sendable { let widthCm: Double; let heightCm: Double }
struct Door: Decodable, Sendable, Identifiable { let id: String; let wall: String; let offsetCm: Double; let clearWidthCm: Double? }
struct Piece: Decodable, Sendable, Identifiable {
    let id: String, label: String
    let xCm: Double, yCm: Double, widthCm: Double, heightCm: Double
    let rotationDeg: Int
    let movable: Bool
}
/// Only what the app draws. The full room travels back to the server as the JSON it came in.
struct Scenario: Decodable, Sendable { let room: Room; let doors: [Door]; let objects: [Piece] }

struct Move: Decodable, Sendable {
    let objectId: String
    let fromXCm: Double, fromYCm: Double, fromRotationDeg: Int
    let toXCm: Double, toYCm: Double, toRotationDeg: Int
}
struct Option: Decodable, Sendable, Identifiable {
    let id: String, label: String
    let steps: [String]
    let moves: [Move]
    let routes: [[[Double]]]
}

/// A scanned room the person is checking, and their changes to it.
struct Draft: Sendable {
    let scenario: Scenario
    let raw: Data // the scenario JSON, sent back unchanged
    var reach: Set<String>
    var keep: Set<String> = []
    var remove: Set<String> = []
    var startDoorId: String?
    let warnings: [String]
}

struct Plan: Decodable, Sendable {
    let headline: String
    let options: [Option]
    let details: [String]
    let scenario: Scenario
}

struct APIError: LocalizedError { let errorDescription: String? }

enum API {
    private static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private static func post(_ path: String, _ body: Data) async throws -> Data {
        var request = URLRequest(url: serverURL.appending(path: path), timeoutInterval: 70)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError(errorDescription: "SpaceAble couldn’t reach its server. Check your internet connection and try again.")
        }
        if (response as? HTTPURLResponse)?.statusCode != 200 {
            struct Failure: Decodable { struct E: Decodable { let message: String }; let error: E }
            throw APIError(errorDescription: (try? decoder().decode(Failure.self, from: data))?.error.message
                ?? "Something went wrong on SpaceAble’s server. Try again.")
        }
        return data
    }

    /// A scan (or, without one, the sample room) → the draft to check.
    static func draft(scan: CapturedRoom?) async throws -> Draft {
        let body = try scan.map { Data(#"{"scan":"#.utf8) + (try JSONEncoder().encode($0)) + Data("}".utf8) } ?? Data("{}".utf8)
        let data = try await post("api/app/draft", body)
        struct Reply: Decodable { let scenario: Scenario; let reach: [String]; let startDoorId: String?; let warnings: [String] }
        let reply = try decoder().decode(Reply.self, from: data)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let raw = try JSONSerialization.data(withJSONObject: json?["scenario"] ?? [:])
        return Draft(scenario: reply.scenario, raw: raw, reach: Set(reply.reach), startDoorId: reply.startDoorId, warnings: reply.warnings)
    }

    /// The checked draft and how the person gets around → a verified rearrangement in plain words.
    static func plan(_ draft: Draft, profile: String, description: String) async throws -> Plan {
        let body: [String: Any] = [
            "scenario": try JSONSerialization.jsonObject(with: draft.raw),
            "profile": profile.isEmpty ? NSNull() : profile,
            "description": description,
            "reach": Array(draft.reach), "keep": Array(draft.keep), "remove": Array(draft.remove),
            "start_door_id": draft.startDoorId ?? NSNull(),
        ]
        return try decoder().decode(Plan.self, from: try await post("api/app/plan", try JSONSerialization.data(withJSONObject: body)))
    }
}
