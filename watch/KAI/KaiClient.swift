import Foundation

/// Talks to the KAI backend. Shared by the app UI and the Siri intents.
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

    /// A typed question (`POST /v1/ask`).
    func ask(_ message: String, conversationId: String? = nil) async throws -> AskResponse {
        var request = makeRequest(url: baseURL.appending(path: "v1/ask"))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            AskRequest(message: message, conversationId: conversationId, timeZone: TimeZone.current.identifier)
        )
        return try await send { try await URLSession.shared.data(for: request) }
    }

    /// A spoken question (`POST /v1/voice`): uploads the recording; the backend transcribes it and answers.
    func ask(audioFile: URL, conversationId: String? = nil) async throws -> AskResponse {
        var components = URLComponents(url: baseURL.appending(path: "v1/voice"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "timeZone", value: TimeZone.current.identifier)]
        if let conversationId {
            components.queryItems?.append(URLQueryItem(name: "conversationId", value: conversationId))
        }
        var request = makeRequest(url: components.url!)
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        return try await send { try await URLSession.shared.upload(for: request, fromFile: audioFile) }
    }

    private func makeRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func send(_ perform: () async throws -> (Data, URLResponse)) async throws -> AskResponse {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await perform()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
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
    /// Missing only when a spoken question was empty and no conversation was started.
    let conversationId: String?
    let reply: String
    /// What the backend heard, for spoken questions.
    let transcript: String?
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
