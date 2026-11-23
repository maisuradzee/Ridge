#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "RidgeSessionLoginSubsystem.generated.h"

class APlayerController;

/**
 * Client-side bridge from an already-authenticated OIDC access token to a RIDGE
 * session. It has no Dedicated Server or gateway service credentials.
 *
 * The bearer join ticket is kept only in the short-lived response/URL memory and
 * is never written to config, replicated state, logs or analytics.
 */
UCLASS()
class RIDGE_API URidgeSessionLoginSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;

    /**
     * Requests a shard reservation and immediately starts ClientTravel.
     * The caller supplies a provider-issued JWT intended for the RIDGE API audience.
     * Success means travel was requested, not that PreLogin/PostLogin has completed.
     */
    void RequestAndConnect(
        const FString& OidcAccessToken,
        const FString& Region,
        APlayerController* LocalPlayerController,
        TFunction<void(bool, const FString&)> Completion);

private:
    FString GatewayBaseUrl;
    bool bRequestInFlight = false;

    bool IsGatewayTransportAllowed() const;
    static bool IsValidRegion(const FString& Region);
    static bool IsValidJoinTicket(const FString& Ticket);
    static bool IsValidServerHost(const FString& Host);
};
