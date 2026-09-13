# Credential Store

`@agent-workbench/provider-registry` 提供安全、可注入、fail-closed 的凭据存储边界。

## 公开接口

```ts
createSecureCredentialStore(options: CredentialStoreOptions): CredentialStore
UnavailableCredentialStore  // fail-closed 默认实现
InMemoryCredentialStore     // 测试用内存实现
MAX_CREDENTIAL_BYTES        // 16 KiB
```

## CredentialBackend

```ts
interface CredentialBackend {
  get(ref): string | undefined | Promise<string | undefined>;
  set(ref, secret): void | Promise<void>;
  has(ref): boolean | Promise<boolean>;
  delete(ref): void | Promise<void>;
}
```

支持 object literal、null-prototype 对象、class 实例（sync/async）。
拒绝 null、数组、primitive、缺少方法、非函数方法。

这是未来 OS Keychain / 平台安全存储的适配边界。

## credentialRef 规则

复用 ProviderRegistry 的 `CREDENTIAL_REF_PATTERN`：

```text
^credential:[a-z][a-z0-9._-]{0,63}$
```

拒绝：空、纯空白、null、非字符串、换行、控制字符、路径穿越、URL scheme。

## secret 规则

- 字符串、非空、非纯空白
- UTF-8 字节数 ≤ `MAX_CREDENTIAL_BYTES`（16 KiB）
- 拒绝 NUL 和控制字符（除常见空白）
- 不自动 trim
- 不出现在错误消息、日志、事件中

## 生命周期

```text
set(ref, secret) → 验证 → 委托 backend
get(ref)         → 验证 → 委托 backend → 检查返回类型
has(ref)         → 验证 → 委托 backend
delete(ref)      → 验证 → 委托 backend
```

后端异常折叠为固定 `credential_backend_failed`，不回显原始异常。

## 默认 fail-closed

`UnavailableCredentialStore`：`get()` 永远返回 `undefined`。
这不是 OS Keychain 实现。

## 未实现

- 真实 OS Keychain / Windows Credential Manager / macOS Keychain
- HTTP 凭据管理接口
- 凭据持久化