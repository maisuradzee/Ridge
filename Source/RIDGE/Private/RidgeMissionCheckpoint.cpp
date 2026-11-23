#include "RidgeMissionCheckpoint.h"

#include "Components/BoxComponent.h"
#include "Engine/World.h"
#include "Engine/GameInstance.h"
#include "RidgeBackendSubsystem.h"
#include "RidgeCharacter.h"
#include "RidgePlayerState.h"

ARidgeMissionCheckpoint::ARidgeMissionCheckpoint()
{
    PrimaryActorTick.bCanEverTick = false;
    bReplicates = false; // Only the authoritative server needs the trigger volume.

    Trigger = CreateDefaultSubobject<UBoxComponent>(TEXT("CheckpointTrigger"));
    SetRootComponent(Trigger);
    Trigger->SetBoxExtent(FVector(180.0f, 180.0f, 140.0f));
    Trigger->SetCollisionEnabled(ECollisionEnabled::QueryOnly);
    Trigger->SetCollisionObjectType(ECC_WorldDynamic);
    Trigger->SetCollisionResponseToAllChannels(ECR_Ignore);
    Trigger->SetCollisionResponseToChannel(ECC_Pawn, ECR_Overlap);
    Trigger->SetGenerateOverlapEvents(true);
    Trigger->OnComponentBeginOverlap.AddDynamic(this, &ARidgeMissionCheckpoint::HandleOverlapBegin);
}

void ARidgeMissionCheckpoint::HandleOverlapBegin(UPrimitiveComponent* OverlappedComponent,
    AActor* OtherActor, UPrimitiveComponent* OtherComponent, int32 OtherBodyIndex,
    bool bFromSweep, const FHitResult& SweepResult)
{
    if (!HasAuthority())
    {
        return;
    }

    ARidgeCharacter* Character = Cast<ARidgeCharacter>(OtherActor);
    if (!Character)
    {
        return;
    }

    ARidgePlayerState* RidgeState = Character->GetPlayerState<ARidgePlayerState>();
    if (!RidgeState)
    {
        return;
    }
    const FString BackendPlayerId = RidgeState->GetBackendPlayerId();
    if (BackendPlayerId.IsEmpty())
    {
        return;
    }

    if (UGameInstance* GameInstance = GetGameInstance())
    {
        if (URidgeBackendSubsystem* Backend = GameInstance->GetSubsystem<URidgeBackendSubsystem>())
        {
            Backend->RecordDeliveryCheckpoint(BackendPlayerId, CheckpointId, Character->GetActorLocation() / 100.0f);
        }
    }
}