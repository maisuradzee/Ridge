#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerState.h"
#include "RidgePlayerState.generated.h"

UCLASS()
class RIDGE_API ARidgePlayerState : public APlayerState
{
    GENERATED_BODY()

public:
    virtual void BeginPlay() override;
    bool SetVerifiedPlayerId(const FString& VerifiedPlayerId);
    FString GetBackendPlayerId() const;
    virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

    UPROPERTY(Replicated, BlueprintReadOnly, Category = "RIDGE|Identity")
    FString RidgePublicId;

private:
    // Canonical account ID is server-only and is never replicated to clients.
    FString VerifiedPlayerId;
};