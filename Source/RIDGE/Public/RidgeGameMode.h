#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "TimerManager.h"
#include "RidgeGameMode.generated.h"

UCLASS()
class RIDGE_API ARidgeGameMode : public AGameModeBase
{
    GENERATED_BODY()

public:
    ARidgeGameMode();
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    FTimerHandle ServerHeartbeatTimer;
    void SendServerHeartbeat();
};