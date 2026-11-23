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
    bool RegisterDedicatedServer();
    void SendShardHeartbeat(int32 CurrentPlayers, const FString& Status);
    void MarkDedicatedServerOffline(int32 CurrentPlayers);
    bool IsDedicatedServerRegistered() const { return bShardRegistered; }
    void ClaimJoinTicket(
        const FString& Ticket,
        const FString& ClaimAttemptId,
        TFunction<void(bool, const FString&, const FString&, const FString&)> Completion);
    void ReleasePlayerSession(const FString& PlayerId, const FString& SessionId);
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
    FString ServerId;
    FString ServerRegion;
    FString ServerHost;
    FString ServerProtocolVersion;
    int32 ServerPort = 7777;
    int32 ServerMaxPlayers = 100;
    bool bShardRegistered = false;
    bool bRegistrationInFlight = false;
    bool bShutdownRequested = false;
    TMap<FString, FActiveDeliveryJob> ActiveJobs;
    TSet<FString> PendingAccepts;

    void CompleteDeliveryJob(const FString& PlayerId);
    void LogServerMessage(const FString& Message) const;
};