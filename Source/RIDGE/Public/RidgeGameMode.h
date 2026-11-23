#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "TimerManager.h"
#include "RidgeGameMode.generated.h"

class AController;
class APlayerController;

UCLASS()
class RIDGE_API ARidgeGameMode : public AGameModeBase
{
    GENERATED_BODY()

public:
    ARidgeGameMode();
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void PreLoginAsync(
        const FString& Options,
        const FString& Address,
        const FUniqueNetIdRepl& UniqueId,
        const FOnPreLoginCompleteDelegate& OnComplete) override;
    virtual FString InitNewPlayer(
        APlayerController* NewPlayerController,
        const FUniqueNetIdRepl& UniqueId,
        const FString& Options,
        const FString& Portal) override;
    virtual void PostLogin(APlayerController* NewPlayer) override;
    virtual void Logout(AController* Exiting) override;

private:
    FTimerHandle ServerHeartbeatTimer;
    FTimerHandle JoinClaimCleanupTimer;
    struct FVerifiedJoinClaim
    {
        FString PlayerId;
        FString SessionId;
        FDateTime ExpiresAtUtc;
    };

    TMap<FString, FVerifiedJoinClaim> VerifiedClaimsByTicket;
    TMap<TWeakObjectPtr<AController>, FVerifiedJoinClaim> PendingJoinClaimsByController;
    TMap<TWeakObjectPtr<AController>, FVerifiedJoinClaim> ActiveJoinClaimsByController;

    void SendServerHeartbeat();
    void ReleaseJoinClaim(const FVerifiedJoinClaim& Claim);
    void PruneExpiredJoinClaims();
    bool ShouldRequireJoinTicket() const;
};