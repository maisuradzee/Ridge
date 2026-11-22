#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameStateBase.h"
#include "RidgeGameState.generated.h"

UCLASS()
class RIDGE_API ARidgeGameState : public AGameStateBase
{
    GENERATED_BODY()

public:
    ARidgeGameState();
    virtual void Tick(float DeltaSeconds) override;
    virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

    UPROPERTY(Replicated, BlueprintReadOnly, Category = "RIDGE|WorldTime")
    float WorldTimeSeconds = 8.0f * 60.0f * 60.0f;

    UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "RIDGE|WorldTime")
    float GameTimeScale = 6.0f;
};