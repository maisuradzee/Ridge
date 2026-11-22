#pragma once

#include "CoreMinimal.h"
#include "AIController.h"
#include "RidgeBotTestController.generated.h"

/**
 * Server-side QA controller for deterministic navigation and movement probes.
 * It is a test instrument, not a production NPC decision controller.
 */
UCLASS(Blueprintable)
class RIDGE_API ARidgeBotTestController : public AAIController
{
    GENERATED_BODY()

public:
    ARidgeBotTestController();

    UFUNCTION(BlueprintCallable, Category = "RIDGE|BotLab")
    bool StartWaypointRoute(const TArray<FVector>& InWaypoints, float AcceptanceRadius = 90.0f);

    UFUNCTION(BlueprintCallable, Category = "RIDGE|BotLab")
    void CancelTestRoute(const FString& Reason = TEXT("operator_cancelled"));

    UFUNCTION(BlueprintCallable, Category = "RIDGE|BotLab")
    void FinalizeTelemetryCapture(const FString& Reason = TEXT("test_completed"));

    virtual void Tick(float DeltaSeconds) override;
    virtual void OnMoveCompleted(FAIRequestID RequestID, const FPathFollowingResult& Result) override;

protected:
    virtual void BeginPlay() override;
    virtual void OnPossess(APawn* InPawn) override;
    virtual void OnUnPossess() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    UPROPERTY(EditAnywhere, Category = "RIDGE|BotLab", meta = (ClampMin = "0.1"))
    float StuckTimeoutSeconds = 4.0f;

    UPROPERTY(EditAnywhere, Category = "RIDGE|BotLab", meta = (ClampMin = "0.1"))
    float MinimumProgressCentimeters = 8.0f;

    UPROPERTY(EditAnywhere, Category = "RIDGE|BotLab")
    bool bWriteTelemetry = true;

    TArray<FVector> Waypoints;
    int32 WaypointIndex = INDEX_NONE;
    float RouteAcceptanceRadius = 90.0f;
    float StuckElapsedSeconds = 0.0f;

    UPROPERTY(EditAnywhere, Category = "RIDGE|BotLab", meta = (ClampMin = "0.1"))
    float TelemetrySampleIntervalSeconds = 0.5f;

    float TelemetryElapsedSeconds = 0.0f;
    float LastProgressDistance = TNumericLimits<float>::Max();
    FVector LastObservedLocation = FVector::ZeroVector;
    FString RouteState = TEXT("idle");
    FString LastRouteReason;
    FGuid ControllerSessionId;
    FGuid ActiveRouteId;
    uint32 RouteGeneration = 0;
    FString TelemetryFilePath;
    bool bTelemetryFinalized = false;
    FAIRequestID ActiveRequestId;
    bool bHasActiveRequestId = false;

    void RequestCurrentWaypoint();
    void WriteTelemetry(const TCHAR* EventName, const FString& Detail = FString(),
                        const FHitResult* Hit = nullptr, const FVector* NormalImpulse = nullptr);
    void MarkRouteTerminal(const FString& NewState, const FString& Reason);

    UFUNCTION()
    void HandlePawnHit(AActor* SelfActor, AActor* OtherActor, FVector NormalImpulse, const FHitResult& Hit);
};
