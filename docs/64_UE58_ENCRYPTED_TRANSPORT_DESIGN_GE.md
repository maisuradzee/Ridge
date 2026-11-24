# RIDGE — UE 5.8 per-connection game transport encryption

**სტატუსი:** არქიტექტურული სპეციფიკაცია / შემდეგი განხორციელების gate. ამ commit-ში packet encryption ჯერ არ არის ჩართული და runtime encryption success არ მტკიცდება.

## 1. რატომ არის ეს ცალკე სამუშაო

Production TLS ingress იცავს RIDGE HTTP API-სა და OIDC Gateway-ს. ის არ შიფრავს Unreal Dedicated Server-ის ცალკე game transport-ს.

Stage 5-ის ამჟამინდელ client handoff-ში ერთჯერადი join ticket გადადის Unreal connection URL-ის option-ად. სანამ game connection-ისთვის ცალკე უსაფრთხო key exchange არ განხორციელდება, ეს ticket არ უნდა ჩაითვალოს transport-ზე დაცულად. ამიტომ Production network play ამ ეტაპზე **არ არის დაშვებული**.

## 2. UE 5.8-ის დადასტურებული შესაძლებლობები

Epic-ის UE 5.8 API დოკუმენტაციაში არსებობს:

- FNetDelegates::OnReceivedNetworkEncryptionToken — network layer ითხოვს encryption key-ს კავშირის გასაგრძელებლად.
- FNetDelegates::OnReceivedNetworkEncryptionFailure — თამაშს შეუძლია განსაზღვროს encryption failure-ის პოლიტიკა; Shipping-ში RIDGE-მა უნდა უარყოს კავშირი.
- UGameInstance::ReceivedNetworkEncryptionToken — client-side callback encryption key-ის მოსამზადებლად.
- FEncryptionKeyResponse / FEncryptionData — key response-ისა და encryption data-ის ტიპები.
- UNetConnection::EnableEncryption და EnableEncryptionServer — per-connection encryption enable API.
- AESGCMHandlerComponent — AES-256-GCM packet-handler plugin.

Packet Handler-ის FEncryptionComponent-ის encryption ნაგულისხმევად გამორთულია; მისი ჩართვა და key data-ის მიწოდება ცალკე ნაბიჯია. UNetDriver::IsEncryptionRequired() ასევე არ ადასტურებს, რომ კონკრეტული connection უკვე სწორად არის დაშიფრული. მიღების ტესტმა უნდა შეამოწმოს ფაქტობრივი UNetConnection-ის მდგომარეობა და უარყოფილი handshake-ები.

ოფიციალური API:
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FNetDelegates?application_version=5.8
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UGameInstance/ReceivedNetworkEncryptionToken
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FEncryptionKeyResponse
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UNetConnection?application_version=5.8
- https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/AESGCMHandlerComponent
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/PacketHandler/FEncryptionComponent?application_version=5.8

## 3. RIDGE-ის უსაფრთხოების პრინციპები

1. **არავითარი shared static AES key.** არც Game binary-ში, არც DefaultEngine.ini-ში, არც ყველა shard-ის საერთო environment variable-ში არ ჩაიწეროს ერთი key.
2. **Per-connection ephemeral key agreement.** თითო client connection-ს უნდა ჰქონდეს ცალკე ephemeral ECDH key pair და უნიკალური handshake context.
3. **Server identity authenticated.** Client server-ის public key-ს ენდობა მხოლოდ HTTPS RIDGE Gateway-იდან მიღებული trusted metadata-ით. Public key უნდა იყოს მიბმული კონკრეტულ serverId-სა და expiry-ს.
4. **Join ticket არ იგზავნება plaintext game transport-ში.** Client ქმნის encrypted join envelope-ს, რომელშიც ticket/claimAttemptId/session context დაშიფრულია server-ის ephemeral public key-ისთვის.
5. **AEAD და replay protection.** Key agreement-ის შედეგიდან HKDF-SHA256-ით მიიღება connection-specific traffic key material; payload encryption იყენებს authenticated encryption-ს (UE 5.8 AES-256-GCM handler). Envelope შეიცავს fresh nonce-ს და transcript/context binding-ს.
6. **Fail closed.** Shipping build-ში missing/invalid/expired key, bad tag, wrong server, reused ticket, failed key exchange ან encryption downgrade იწვევს კავშირის უარყოფას. Unencrypted fallback არ არსებობს.
7. **Secrets არ ილოგება.** ephemeral private keys, derived traffic keys, join tickets და encrypted envelope-ის plaintext არ მოხვდეს logs, telemetry ან crash breadcrumbs-ში.

## 4. Handshake-ის მიზნობრივი ნაკადი

1. Client ქმნის ephemeral key pair-ს local memory-ში და HTTPS-ით აგზავნის მხოლოდ public key-ს Gateway-ის session request-ში.
2. Gateway არჩევს healthy shard-ს, ამოწმებს Dedicated Server-ის მიერ ახლახან დარეგისტრირებულ ephemeral public key-ს და ბრუნებს serverId-ს, keyId-ს, public key-ს და expiry-ს იმავე HTTPS response-ში, სადაც join reservation გაიცემა.
3. Client ამოწმებს server identity binding-ს; ECDH-ით და HKDF-SHA256-ით ქმნის მხოლოდ ამ connection-ისთვის განკუთვნილ secret-ს.
4. Client აწყობს versioned ridgeJoinEnvelope-ს. Envelope-ის plaintext claim data შეიცავს ერთჯერად join ticket-ს, claimAttemptId-ს, sessionId-ს, serverId-ს და expiry-ს; ეს შინაარსი გადის AEAD encryption-ს და transport-ში გადადის მხოლოდ ciphertext + nonce + tag სახით.
5. Dedicated Server თავისი ephemeral private key-ით აღადგენს connection secret-ს, ამოწმებს envelope-ის authentication tag-სა და context-ს, შემდეგ backend-ში ასრულებს join-ticket claim-ს. Backend-ის არსებული single-use და shard-bound წესები კვლავ სავალდებულოა.
6. Client და server ერთსა და იმავე transcript/context-ზე დაყრდნობით ამზადებენ traffic key material-ს და UE 5.8 connection-ზე ჩართავენ AES-GCM packet handler-ს.
7. Gameplay/replication traffic-ის დაშვებამდე server ადასტურებს, რომ connection encryption რეალურად enabled არის. ნებისმიერ failure-ზე connection წყდება.

### Backend/API ცვლილებების საჭიროება

ეს handshake საჭიროებს შემდეგ API კონტრაქტებს; ამ commit-ში ისინი ჯერ არ არის იმპლემენტირებული:

- Dedicated Server-ის რეგისტრაცია/heartbeat ატარებს მხოლოდ ephemeral **public** transport key-სა და keyId-ს; კერძო ნაწილი რჩება შესაბამის server process-ში.
- Gateway session request იღებს client ephemeral public key-ს და აკავშირებს მას კონკრეტულ reservation/ticket attempt-თან.
- Gateway response აბრუნებს server public key-ის სანდო binding-ს და expiry-ს.
- Server-ის ticket-claim flow იღებს decrypted envelope-ის მონაცემებს და ადარებს serverId-ს, sessionId-ს, ticket hash-ს, claimAttemptId-ს და expiry-ს.
- Key rotation/revocation ხდება server process restart-ისას ან incident response-ის დროს; ძველი keyId-ით ახალი connection არ უნდა გაიხსნას.

ECDH-ის curve, UE platform-ებზე მხარდაჭერილი crypto provider და FEncryptionData-ში key material-ის ზუსტი mapping უნდა დადასტურდეს UE 5.8-ის რეალური headers/build-ის მიხედვით. ამ დოკუმენტში არ არის გამოგონილი C++ field names ან დაუდასტურებელი engine callback ordering.

## 5. მიღების ტესტები — ყველა სავალდებულოა

| ტესტი | PASS პირობა |
|---|---|
| Game + Editor + Dedicated Server UBT/UHT | სამივე target კომპილირდება UE 5.8-ზე |
| Two-client Dedicated Server session | ორივე client შედის მხოლოდ encrypted handshake-ის შემდეგ |
| Packet capture | game payload და join ticket plaintext-ად არ ჩანს |
| Tampered envelope | authentication tag ვერ გადის; კავშირი უარყოფილია |
| Wrong shard/server key | claim უარყოფილია |
| Expired key / envelope | კავშირი უარყოფილია |
| Reused join ticket / claim attempt | მეორე გამოყენება უარყოფილია |
| Missing encryption handler / key | Shipping-ში კავშირი უარყოფილია |
| Downgrade attempt | unencrypted fallback არ ხდება |
| Key rotation | ძველი key-ით ახალი session ვერ იხსნება |
| Reconnect | ახალი ticket + ახალი ephemeral key-ით ხელახლა handshake სრულდება |
| 25 / 50 / 100 clients | CPU, memory, packet rate, tick time და p95/p99 latency ჩაიწერება |

**500 CCU acceptance** მხოლოდ ზემოთ ჩამოთვლილი ტესტების შემდეგ ჩატარდება. 500 virtual HTTP client API preflight ამ ტესტს არ ანაცვლებს.

## 6. მიმდინარე მდგომარეობა

- Production API TLS ingress config: committed; Nginx parser და security contract tests PASS.
- OIDC Gateway + one-time join ticket: Stage 5 source/PostgreSQL CI PASS.
- UE client session handoff: source/static checks PASS.
- UE 5.8 Game/Editor/Server UBT/UHT: **NOT_RUN** — საჭიროა ridge-ue58 Windows runner.
- AES-GCM per-connection game transport: **NOT_IMPLEMENTED**.
- Two-client encrypted Dedicated Server runtime: **NOT_RUN**.
- True 500 connected Unreal clients: **NOT_RUN**.

ამიტომ PR3 რჩება Draft-ად და Production release არ არის დაშვებული.


## 7. UE 5.8 crypto plugin preparation — 2026-11-24

The project descriptor now explicitly enables the engine plugins `PlatformCrypto` and `AESGCMHandlerComponent`. The manual Windows Build Gate also verifies that both plugin descriptors exist in the selected UE 5.8 engine installation before starting UBT/UHT.

This is a build prerequisite only. It does **not** add a PacketHandler profile, does not supply encryption keys, does not enable encryption on a connection and does not make Production multiplayer safe.

Verified against Epic's UE 5.8 API documentation:
- `FAESGCMHandlerComponent` is the AES-256-GCM packet-handler implementation and uses a 32-byte key: https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/AESGCMHandlerComponent/FAESGCMHandlerComponent?lang=en-US
- `FEncryptionComponent::SetEncryptionData` must be called before `EnableEncryption`: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/PacketHandler/FEncryptionComponent/SetEncryptionData
- `FNetDelegates` exposes the encryption-token, acknowledgement and failure delegates: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FNetDelegates?application_version=5.8
- `UGameInstance::ReceivedNetworkEncryptionToken` must complete its response delegate when asynchronous key preparation finishes: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UGameInstance/ReceivedNetworkEncryptionToken
- `UNetConnection` provides separate client and server encryption enable methods: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UNetConnection?application_version=5.8

Before configuring a PacketHandler profile, RIDGE must implement and verify ephemeral key agreement, server identity authentication, ticket envelope protection, distinct per-direction/connection key derivation, and Shipping fail-closed behavior. The exact `FEncryptionData` mapping and supported platform crypto operations remain gated on the actual UE 5.8 headers and Windows compile.

Current acceptance status remains:
- Plugin descriptors enabled in project: **STATIC_CHECKED**.
- Plugin binaries/module discovery on an actual UE 5.8 installation: **NOT_RUN**.
- UBT/UHT Game + Editor + Server: **NOT_RUN**.
- AES-GCM handshake and encrypted packet transport: **NOT_IMPLEMENTED**.


## 8. UE 5.8 crypto plugin preparation — verified API boundary (2026-11-24)

Project descriptor `RIDGE.uproject` explicitly enables:
- `PlatformCrypto`
- `AESGCMHandlerComponent`

The manual Windows Build Gate checks that both plugin descriptor files exist in the selected UE 5.8 installation before starting UBT/UHT. This proves only project configuration and engine-file availability; it does not prove module compilation or runtime availability.

Epic's UE 5.8 API reference confirms the following concrete fields in `FEncryptionData`:
- `Key`: `TArray<uint8>`
- `Identifier`: `FString`
- `Fingerprint`: `TArray<uint8>`

The AES-GCM handler is documented as AES-256-GCM and requires a 32-byte key. The PacketHandler API says `SetEncryptionData` must be called before `EnableEncryption`. This is the intended handoff boundary for the final connection traffic key, but the exact fingerprint/identifier semantics must be confirmed from the installed UE 5.8 headers and tests before assignment.

The public UE 5.8 `FEncryptionContextOpenSSL` reference lists AES-256-GCM, random-byte generation, SHA-256 and RSA operations. It does not list ECDH or HKDF methods in that API surface. Therefore the current `PlatformCrypto` documentation is not sufficient evidence that RIDGE can implement its required ephemeral ECDH + HKDF flow through that interface alone. The actual supported provider/API must be verified from the installed headers and target platform toolchains before the handshake is implemented.

No PacketHandler profile is enabled yet. No key is supplied, and no game connection encryption is active. This is intentional: enabling the handler without a complete per-connection key exchange, authenticated server identity and fail-closed failure policy would create a misleading or unsafe partial deployment.

Official UE 5.8 API references:
- `FEncryptionData`: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/CoreUObject/FEncryptionData
- `FAESGCMHandlerComponent`: https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/AESGCMHandlerComponent/FAESGCMHandlerComponent?lang=en-US
- `FEncryptionComponent::SetEncryptionData`: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/PacketHandler/FEncryptionComponent/SetEncryptionData
- `FNetDelegates`: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FNetDelegates?application_version=5.8
- `FEncryptionContextOpenSSL`: https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PlatformCryptoContext/FEncryptionContextOpenSSL

Updated acceptance status:
- Project plugin enablement: **IMPLEMENTED / STATIC_CHECKED**.
- Windows Build Gate plugin-file checks: **IMPLEMENTED / CI-CONTRACT_CHECKED**.
- UE plugin presence on the user's actual installation: **NOT_RUN**.
- UBT/UHT Game + Editor + Dedicated Server: **NOT_RUN**.
- ECDH/HKDF provider selection and per-connection handshake: **NOT_IMPLEMENTED**.
- AES-GCM traffic-key install and encrypted packet runtime: **NOT_IMPLEMENTED**.


## 9. Production Gateway fail-closed enforcement — 2026-11-24

The backend now enforces the documented Production boundary in code, not only in the design document.

- `backend/src/game-transport-policy.mjs` defines `GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED = false`.
- The public `POST /v1/gateway/session` route calls `assertGameTransportReady({ environment: ENV })` before OIDC identity verification, shard allocation or join-ticket issuance.
- In Production, the route returns HTTP 503 with `GAME_TRANSPORT_ENCRYPTION_NOT_READY` until a reviewed source change flips the runtime-verification constant after all encrypted-handshake acceptance tests pass.
- The gate is not controlled by an environment variable or caller-supplied request value. A deployment operator cannot accidentally enable insecure Production join tickets by setting a config flag.
- Development and isolated test flows remain available.
- Added backend tests verify development behavior, Production fail-closed behavior, the explicit positive policy branch and that the Gateway guard runs before identity verification/allocation/ticket issuance.

This is an intentional temporary Production blocker. It does not claim that AES-GCM transport exists; instead, it prevents the current plaintext join-ticket URL handoff from being used for Production network sessions.

Acceptance state:
- Production session gate: **IMPLEMENTED / CI-VERIFIED**.
- Actual encrypted UE transport: **NOT_IMPLEMENTED**.
- UBT/UHT and encrypted PIE/two-client test: **NOT_RUN**.
