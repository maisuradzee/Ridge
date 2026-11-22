#include "RidgeGameState.h"
#include "Net/UnrealNetwork.h"

ARidgeGameState::ARidgeGameState()
{
    bReplicates = true;
    PrimaryActorTick.bCanEverTick = true;
    NetUpdateFrequency = 2.0f;
}

void ARidgeGameState::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);

    if (HasAuthority())
    {
        WorldTimeSeconds = FMath::Fmod(WorldTimeSeconds + (DeltaSeconds * GameTimeScale), 24.0f * 60.0f * 60.0f);
        if (WorldTimeSeconds < 0.0f)
        {
            WorldTimeSeconds += 24.0f * 60.0f * 60.0f;
        }
    }
}

void ARidgeGameState::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(ARidgeGameState, WorldTimeSeconds);
}