# RIDGE — Unreal client OIDC session handoff

**Stage:** 5 / player-facing connection flow  
**Engine:** Unreal Engine 5.8  
**Status:** Client-side gateway request and travel source wiring added; real UBT/UHT and provider UI remain open.

## 1. Responsibility boundaries

The authentication UI or identity-provider SDK is responsible for signing the user in and supplying a short-lived OIDC access JWT issued for the configured RIDGE API audience (`ridge-game-api`). This subsystem does not implement the provider's authorization-code/PKCE, browser redirect, MFA or account recovery screens.

`URidgeSessionLoginSubsystem` accepts that access token and:
1. sends `POST /v1/gateway/session` with `Authorization: Bearer <OIDC access token>`;
2. sends the requested region (default `ge-tbilisi`);
3. validates the Gateway's selected server host, port, short-lived ticket, stable claimAttemptId UUID and expiry;
4. constructs the connection options in memory;
5. calls `APlayerController::ClientTravel` to the assigned server.

A successful callback means the travel request started. It does not mean that PreLogin/PostLogin completed; the Dedicated Server still has final authority to accept or reject the ticket.

## 2. Configuration

The non-secret Gateway base URL is read from `Config/DefaultGame.ini`:

    [RidgeSessionLogin]
    GatewayBaseUrl=http://127.0.0.1:8787

This checked-in default is development-only. A packaged production build must override it with the real HTTPS Gateway URL, for example:

    [RidgeSessionLogin]
    GatewayBaseUrl=https://api.ridge.example

The client subsystem does not read or contain:
- `RIDGE_SERVER_EVENT_TOKEN`;
- `RIDGE_SERVER_PROVISIONING_TOKEN`;
- `RIDGE_GATEWAY_TOKEN`.

It never calls internal gateway/provisioning routes.

## 3. Calling the subsystem

The caller obtains the subsystem from the local GameInstance and supplies the provider-issued JWT:

    UGameInstance* GameInstance = GetGameInstance();
    if (UGameInstance* GI = GameInstance)
    {
        if (URidgeSessionLoginSubsystem* Login = GI->GetSubsystem<URidgeSessionLoginSubsystem>())
        {
            Login->RequestAndConnect(
                OidcAccessToken,
                TEXT("ge-tbilisi"),
                GetOwningPlayerController(),
                [](bool bStarted, const FString& Message)
                {
                    // Display Message in the login UI.
                    // Do not log the access token, join ticket or full connect URL.
                });
        }
    }

Do not save the OIDC token or the returned one-time join ticket to SaveGame, config, crash breadcrumbs, analytics, clipboard, persistent logs or replicated properties.

## 4. Transport and response validation

- HTTPS is accepted for Gateway transport.
- Plain HTTP is accepted only for exact loopback authorities (`127.0.0.1`, `localhost`, `[::1]`) with an optional valid numeric port.
- Prefix lookalikes such as `localhost.attacker.example` are rejected.
- Only HTTP 201 is treated as a session response.
- The response size is bounded; host, port, ticket, UUID and expiry are validated before travel.
- The connect URL is never written to logs.
- The bearer ticket is short lived and bound by the backend to one shard and one claim attempt.

The bearer ticket is passed in Unreal connection options. HTTPS to the HTTP Gateway does not encrypt the subsequent game connection. Production must enable and verify appropriate Unreal network encryption/transport protection before the bearer ticket is sent over the game connection.

## 5. Source verification boundary

Static checks cover the gateway URL, Bearer header, region body, response validation, absence of internal service secrets and the four-argument UE 5.8 `ClientTravel` call. They are not C++ compilation.

Still required:
- provider authorization-code/PKCE client integration and real OIDC access token;
- production Gateway URL and TLS ingress;
- UE 5.8 UBT/UHT compile for Editor and RIDGEServer targets;
- packaged client calls `RequestAndConnect`;
- Dedicated Server PreLogin accepts a valid ticket and rejects missing/expired/wrong-shard tickets;
- two-client PIE, disconnect/reconnect and encrypted game transport test.


## 6. CI result — 2026-11-23

Revision f689c702c267a90486f329850d2b790131bb5a82 passed the Stage 5 preflight:

- [Stage 5 Multiplayer Preflight](https://github.com/maisuradzee/Ridge/actions/runs/45138435495): SUCCESS
- Python/BotLab/Unreal source regression: **74/74 PASS**
- Unreal project static validator: **STATIC_PASS**; UBT/UHT **NOT RUN**
- Load runner unit tests: **6/6 PASS**
- Backend Node suite: **55 PASS / 0 FAIL / 2 SKIP**
- 500 virtual-user development API preflight: **6,996 requests / 0 failures / 437.15 req/s**
- p50 **0.39 ms**, p95 **0.71 ms**, p99 **2.62 ms**, max **6.49 ms**, max observed in-flight requests **7**

The PostgreSQL 16 migration/live integration result remains the previously verified Stage 5 backend result on commit e2df4c454c332e9362d7e44ca4044a3f16c8058c: migrations 001–006 and **57 PASS / 0 FAIL / 0 SKIP**. This client-only commit did not alter backend or migration files.

The CI proves source-contract/static behavior only. No UE 5.8 C++ compile/UHT, packaged client, provider UI, game-connection encryption or actual ClientTravel-to-PreLogin network join has run yet.


## 7. Blueprint/UI entry point

The GameInstance subsystem exposes a Blueprint-callable wrapper for the login UI:

- Obtain the GameInstance subsystem URidgeSessionLoginSubsystem.
- Bind to the OnLoginAttemptCompleted event before starting the request.
- Call RequestAndConnectFromBlueprint with the provider-issued OIDC access token, selected region (or ge-tbilisi), and local PlayerController.
- When bTravelStarted is true, the client travel request has started. It is not confirmation that the Dedicated Server accepted PreLogin; show final in-game state only after the server session is established.

The subsystem does not present provider UI and does not acquire or refresh the OIDC token itself. The caller remains responsible for securely obtaining a token for the RIDGE API audience and refreshing/re-authenticating before expiry. Do not store the access token in SaveGame or log it. The delegate message is safe for UI display and intentionally excludes credential values.


## 8. Blueprint login entry and CI result — 2026-11-23

The subsystem now exposes:
- BlueprintCallable: RequestAndConnectFromBlueprint(OidcAccessToken, Region, LocalPlayerController)
- BlueprintAssignable: OnLoginAttemptCompleted(bTravelStarted, Message)

Bind the event before calling the method. The token must already have been obtained from the chosen identity-provider client integration and must be issued for the RIDGE API audience. The event reports whether the client travel request was started; only the Dedicated Server can confirm the actual join after PreLogin/PostLogin.

Stage 5 CI on revision 4ce132707cb64ed53c34ec2d60aefec57dda5532: [SUCCESS](https://github.com/maisuradzee/Ridge/actions/runs/45138993647).

- Python/BotLab/Unreal source regression: **75/75 PASS**
- Unreal project static validator: **STATIC_PASS**; UBT/UHT **NOT RUN**
- Load runner unit: **6/6 PASS**
- Backend Node: **55 PASS / 0 FAIL / 2 SKIP**
- 500 virtual API preflight: **6,997 requests / 0 errors / 437.38 req/s**
- p50 **0.22 ms**, p95 **0.49 ms**, p99 **1.38 ms**, max **8.8 ms**, max in-flight **7**

PostgreSQL migration/live integration is unchanged by the client-only login UI wrapper. The previous backend verification remains: migrations 001–006, **57 PASS / 0 FAIL / 0 SKIP**, on revision e2df4c454c332e9362d7e44ca4044a3f16c8058c.

Still not verified: external OIDC login/PKCE UI, a real token from the selected identity provider, packaged client invocation, UBT/UHT, actual ClientTravel-to-PreLogin network join, encrypted game transport and true Unreal CCU load.
