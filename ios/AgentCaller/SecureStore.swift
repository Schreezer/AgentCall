import Foundation
import Security

protocol CredentialStoring {
    func string(for key: String) -> String?
    @discardableResult func set(_ value: String, for key: String) -> Bool
    @discardableResult func remove(_ key: String) -> Bool
}

final class KeychainCredentialStore: CredentialStoring {
    private let service: String

    init(service: String = "com.chirag.agentcaller.credentials") {
        self.service = service
    }

    func string(for key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func set(_ value: String, for key: String) -> Bool {
        let data = Data(value.utf8)
        let query = baseQuery(key)
        let update = [kSecValueData as String: data]
        if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecSuccess { return true }
        var addition = query
        addition[kSecValueData as String] = data
        addition[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(addition as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func remove(_ key: String) -> Bool {
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}
