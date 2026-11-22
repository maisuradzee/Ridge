#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "RidgeBackendSubsystem.generated.h"

/**
 * Dedicated-server-only bridge to the RIDGE backend.
 * The service token is read from the server process environment and is never
 * replicated to clients or stored in game assets/configuration.
 */
UCLASS()
class RIDGE_API URidgeBackendSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    bool EnsureServerConfiguration();
    void AcceptDeliveryJob(const FString& PlayerId);
    void RecordDeliveryCheckpoint(const FString& PlayerId, const FString& CheckpointId, const FVector& ObservedPositionMeters);

private:
    struct FActiveDeliveryJob
    {
        FString JobId;
        FString CompletionProof;
        int32 CompletedCount = 0;
        int32 RequiredCount = 0;
        bool bCompleting = false;
    };

    FString ApiBaseUrl;
    FString ServerToken;
    TMap<FString, FActiveDeliveryJob> ActiveJobs;
    TSet<FString> PendingAccepts;

    void CompleteDeliveryJob(const FString& PlayerId);
    void LogServerMessage(const FString& Message) const;
};