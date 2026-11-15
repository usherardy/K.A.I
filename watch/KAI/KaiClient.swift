import Foundation

/// Talks to the KAI backend (`POST /v1/ask`). Shared by the app UI and the Siri intents.
struct KaiClient: Sendable {
    let baseURL: URL
    let apiKey: String

    /// Reads the backend URL and key that the build injected into Info.plist
    /// (see Config/KAI.xcconfig and Config/Secrets.xcconfig).
    static func fromBundle(_ bundle: Bundle = .main) throws -> KaiClient {
        guard
            let rawURL = bundle.object(forInfoDictionaryKey: "KAIBaseURL") as? String,
            let url = URL(string: rawURL.trimmingCharacters(in: .whitespaces)),
            url.scheme == "https" || url.scheme == "http",
            url.host() != nil
        else { throw KaiError.notConfigured("KAI_BASE_URL") }

        guard let key = bundle.object(forInfoDictionaryKey: "KAIAPIKey") as? String, !key.isEmpty, !key.hasPrefix("$(")
        else { throw KaiError.notConfigured("KAI_API_KEY") }

        return KaiClient(baseURL: url, apiKey: key)
    }

    func ask(_ message: String, conversationId: String? = nil) async throws -> AskResponse {
        var request = URLRequest(url: baseURL.appending(path: "v1/ask"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(
            AskRequest(message: message, conversationId: conversationId, timeZone: TimeZone.current.identifier)
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw KaiError.network("Kai took too long to answer.")
        } catch let error as URLError {
            throw KaiError.network(error.code == .notConnectedToInternet ? "No internet connection." : "Couldn't reach Kai.")
        }

        guard let http = response as? HTTPURLResponse else { throw KaiError.network("Couldn't reach Kai.") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw KaiError.server(message ?? "Kai's server returned an error (\(http.statusCode)).")
        }
        return try JSONDecoder().decode(AskResponse.self, from: data)
    }
}

struct AskRequest: Encodable {
    let message: String
    let conversationId: String?
    let timeZone: String
}

struct AskResponse: Decodable, Sendable {
    let conversationId: String
    let reply: String
}

private struct ErrorResponse: Decodable {
    let error: String
}

enum KaiError: LocalizedError {
    case notConfigured(String)
    case network(String)
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured(let setting):
            "Kai isn't set up yet: add \(setting) to Config/Secrets.xcconfig and rebuild."
        case .network(let message), .server(let message):
            message
        }
    }
}
