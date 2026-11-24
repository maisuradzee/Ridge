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
