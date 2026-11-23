#include "RidgeGameMode.h"
#include "RidgeBackendSubsystem.h"
#include "RidgeCharacter.h"
#include "RidgeGameState.h"
#include "RidgePlayerState.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "TimerManager.h"

ARidgeGameMode::ARidgeGameMode()
{
    DefaultPawnClass = ARidgeCharacter::StaticClass();
    GameStateClass = ARidgeGameState::StaticClass();
    PlayerStateClass = ARidgePlayerState::StaticClass();
}

void ARidgeGameMode::BeginPlay()
{
    Super::BeginPlay();

    if (!HasAuthority() || !GetWorld() || GetWorld()->GetNetMode() == NM_Client)
    {
        return;
    }

    if (UGameInstance* GameInstance = GetGameInstance())
    {
        if (URidgeBackendSubsystem* Backend = GameInstance->GetSubsystem<URidgeBackendSubsystem>())
        {
            Backend->RegisterDedicatedServer();
        }
    }

    // Registry lease/heartbeat freshness is 45 seconds. A 15-second cadence
    // tolerates a transient failure while keeping shard presence reasonably fresh.
    GetWorld()->GetTimerManager().SetTimer(
        ServerHeartbeatTimer,
        this,
        &ARidgeGameMode::SendServerHeartbeat,
        15.0f,
        true,
        15.0f);
}

void ARidgeGameMode::SendServerHeartbeat()
{
    if (!HasAuthority() || !GetWorld() || GetWorld()->GetNetMode() == NM_Client)
    {
        return;
    }

    if (UGameInstance* GameInstance = GetGameInstance())
    {
        if (URidgeBackendSubsystem* Backend = GameInstance->GetSubsystem<URidgeBackendSubsystem>())
        {
            if (Backend->IsDedicatedServerRegistered())
            {
                Backend->SendShardHeartbeat(GetNumPlayers(), TEXT("ready"));
            }
            else
            {
                // Re-register after transient startup/network failures.
                Backend->RegisterDedicatedServer();
            }
        }
    }
}

void ARidgeGameMode::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(ServerHeartbeatTimer);
    }

    if (HasAuthority())
    {
        if (UGameInstance* GameInstance = GetGameInstance())
        {
            if (URidgeBackendSubsystem* Backend = GameInstance->GetSubsystem<URidgeBackendSubsystem>())
            {
                Backend->MarkDedicatedServerOffline(GetNumPlayers());
            }
        }
    }

    Super::EndPlay(EndPlayReason);
}
