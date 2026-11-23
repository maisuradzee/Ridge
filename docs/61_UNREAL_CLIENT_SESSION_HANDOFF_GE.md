# RIDGE — Unreal client OIDC session handoff

**Stage:** 5 / player-facing connection flow  
**Engine:** Unreal Engine 5.8  
**Status:** Client-side gateway request and travel source wiring added; real UBT/UHT and provider UI remain open.

## 1. Responsibility boundaries

The authentication UI or identity-provider SDK is responsible for signing the user in and supplying a short-lived OIDC access JWT issued for the configured RIDGE API audience (\`ridge-game-api\`). This subsystem does not implement the provider's authorization-code/PKCE, browser redirect, MFA or account recovery screens.

\`URidgeSessionLoginSubsystem\` accepts that access token and:
1. sends \`POST /v1/gateway/session\` with \`Authorization: Bearer <OIDC access token>\`;
2. sends the requested region (default \`ge-tbilisi\`);
3. validates the Gateway's selected server host, port, short-lived ticket, stable claimAttemptId UUID and expiry;
4. constructs the connection options in memory;
5. calls \`APlayerController::ClientTravel\` to the assigned server.

A successful callback means the travel request started. It does not mean that PreLogin/PostLogin completed; the Dedicated Server still has final authority to accept or reject the ticket.

## 2. Configuration

The non-secret Gateway base URL is read from \`Config/DefaultGame.ini\`:

    [RidgeSessionLogin]
    GatewayBaseUrl=http://127.0.0.1:8787

This checked-in default is development-only. A packaged production build must override it with the real HTTPS Gateway URL, for example:

    [RidgeSessionLogin]
    GatewayBaseUrl=https://api.ridge.example

The client subsystem does not read or contain:
- \`RIDGE_SERVER_EVENT_TOKEN\`;
- \`RIDGE_SERVER_PROVISIONING_TOKEN\`;
- \`RIDGE_GATEWAY_TOKEN\`.

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
- Plain HTTP is accepted only for exact loopback authorities (\`127.0.0.1\`, \`localhost\`, \`[::1]\`) with an optional valid numeric port.
- Prefix lookalikes such as \`localhost.attacker.example\` are rejected.
- Only HTTP 201 is treated as a session response.
- The response size is bounded; host, port, ticket, UUID and expiry are validated before travel.
- The connect URL is never written to logs.
- The bearer ticket is short lived and bound by the backend to one shard and one claim attempt.

The bearer ticket is passed in Unreal connection options. HTTPS to the HTTP Gateway does not encrypt the subsequent game connection. Production must enable and verify appropriate Unreal network encryption/transport protection before the bearer ticket is sent over the game connection.

## 5. Source verification boundary

Static checks cover the gateway URL, Bearer header, region body, response validation, absence of internal service secrets and the four-argument UE 5.8 \`ClientTravel\` call. They are not C++ compilation.

Still required:
- provider authorization-code/PKCE client integration and real OIDC access token;
- production Gateway URL and TLS ingress;
- UE 5.8 UBT/UHT compile for Editor and RIDGEServer targets;
- packaged client calls \`RequestAndConnect\`;
- Dedicated Server PreLogin accepts a valid ticket and rejects missing/expired/wrong-shard tickets;
- two-client PIE, disconnect/reconnect and encrypted game transport test.
