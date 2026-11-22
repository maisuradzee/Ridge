#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "RidgeMissionCheckpoint.generated.h"

class UBoxComponent;

/** Server-side overlap trigger for delivery missions. Place in the level and
 * set CheckpointId to warehouse_pickup or delivery_dropoff. */
UCLASS()
class RIDGE_API ARidgeMissionCheckpoint : public AActor
{
    GENERATED_BODY()

public:
    ARidgeMissionCheckpoint();

protected:
    UPROPERTY(VisibleAnywhere, Category = "RIDGE|Mission")
    TObjectPtr<UBoxComponent> Trigger;

    UPROPERTY(EditInstanceOnly, BlueprintReadOnly, Category = "RIDGE|Mission")
    FString CheckpointId = TEXT("warehouse_pickup");

    UFUNCTION()
    void HandleOverlapBegin(UPrimitiveComponent* OverlappedComponent, AActor* OtherActor,
        UPrimitiveComponent* OtherComponent, int32 OtherBodyIndex, bool bFromSweep,
        const FHitResult& SweepResult);
};