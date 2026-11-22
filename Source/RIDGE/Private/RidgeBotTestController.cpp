#include "RidgeBotTestController.h"

#include "AITypes.h"
#include "Components/PrimitiveComponent.h"
#include "PhysicalMaterials/PhysicalMaterial.h"
#include "Navigation/NavigationTypes.h"
#include "Navigation/PathFollowingComponent.h"
#include "GameFramework/Character.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformFileManager.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

ARidgeBotTestController::ARidgeBotTestController()
{
    PrimaryActorTick.bCanEverTick = true;
}

void ARidgeBotTestController::BeginPlay()
{
    Super::BeginPlay();
    if (HasAuthority())
    {
        ControllerSessionId = FGuid::NewGuid();
        const FString Directory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("RIDGE"), TEXT("BotLab"));
        IFileManager::Get().MakeDirectory(*Directory, true);
        TelemetryFilePath = FPaths::Combine(Directory, FString::Printf(TEXT("movement_telemetry_%s.jsonl"), *ControllerSessionId.ToString(EGuidFormats::Digits)));
        WriteTelemetry(TEXT("controller_ready"));
    }
}

void ARidgeBotTestController::OnPossess(APawn* InPawn)
{
    Super::OnPossess(InPawn);
    if (HasAuthority() && InPawn)
    {
        InPawn->OnActorHit.AddUniqueDynamic(this, &ARidgeBotTestController::HandlePawnHit);
        WriteTelemetry(TEXT("pawn_possessed"));
    }
}

void ARidgeBotTestController::OnUnPossess()
{
    if (HasAuthority() && RouteState == TEXT("moving"))
    {
        MarkRouteTerminal(TEXT("cancelled"), TEXT("pawn_unpossessed"));
        StopMovement();
    }
    if (APawn* CurrentPawn = GetPawn())
    {
        CurrentPawn->OnActorHit.RemoveDynamic(this, &ARidgeBotTestController::HandlePawnHit);
    }
    Super::OnUnPossess();
    if (HasAuthority())
    {
        WriteTelemetry(TEXT("pawn_unpossessed"));
    }
}

void ARidgeBotTestController::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (HasAuthority() && !bTelemetryFinalized)
    {
        if (RouteState == TEXT("moving"))
        {
            MarkRouteTerminal(TEXT("cancelled"), TEXT("controller_end_play"));
            StopMovement();
        }
        WriteTelemetry(TEXT("controller_end_play"), TEXT("actor_end_play"));
        WriteTelemetry(TEXT("capture_finalized"), TEXT("controller_end_play"));
        bTelemetryFinalized = true;
    }
    Super::EndPlay(EndPlayReason);
}

void ARidgeBotTestController::FinalizeTelemetryCapture(const FString& Reason)
{
    if (!HasAuthority() || bTelemetryFinalized)
    {
        return;
    }
    if (RouteState == TEXT("moving"))
    {
        MarkRouteTerminal(TEXT("cancelled"), TEXT("capture_finalized_with_active_route"));
        StopMovement();
    }
    WriteTelemetry(TEXT("capture_finalized"), Reason);
    bTelemetryFinalized = true;
}

void ARidgeBotTestController::HandlePawnHit(AActor* SelfActor, AActor* OtherActor, FVector NormalImpulse, const FHitResult& Hit)
{
    if (!HasAuthority())
    {
        return;
    }
    // Record a class label rather than an actor instance name; test telemetry must
    // not capture player-entered names or other identity-bearing labels.
    const FString OtherClass = OtherActor ? OtherActor->GetClass()->GetName() : TEXT("world_geometry_or_unknown");
    WriteTelemetry(TEXT("pawn_collision"), OtherClass, &Hit, &NormalImpulse);
}

bool ARidgeBotTestController::StartWaypointRoute(const TArray<FVector>& InWaypoints, float AcceptanceRadius)
{
    if (!HasAuthority() || bTelemetryFinalized || InWaypoints.IsEmpty() || InWaypoints.Num() > 256 || !GetPawn())
    {
        WriteTelemetry(TEXT("route_rejected"), TEXT("requires_authority_possessed_pawn_and_1_to_256_waypoints"));
        return false;
    }

    for (const FVector& Waypoint : InWaypoints)
    {
        if (!FMath::IsFinite(Waypoint.X) || !FMath::IsFinite(Waypoint.Y) || !FMath::IsFinite(Waypoint.Z))
        {
            WriteTelemetry(TEXT("route_rejected"), TEXT("waypoint_contains_non_finite_component"));
            return false;
        }
    }

    if (RouteState == TEXT("moving"))
    {
        CancelTestRoute(TEXT("superseded_by_new_route"));
    }
    StopMovement();
    Waypoints = InWaypoints;
    WaypointIndex = 0;
    RouteAcceptanceRadius = FMath::IsFinite(AcceptanceRadius) ? FMath::Max(10.0f, AcceptanceRadius) : 90.0f;
    StuckElapsedSeconds = 0.0f;
    TelemetryElapsedSeconds = 0.0f;
    LastProgressDistance = TNumericLimits<float>::Max();
    LastObservedLocation = GetPawn()->GetActorLocation();
    ActiveRouteId = FGuid::NewGuid();
    ++RouteGeneration;
    RouteState = TEXT("moving");
    LastRouteReason.Reset();
    bHasActiveRequestId = false;
    WriteTelemetry(TEXT("route_started"));
    RequestCurrentWaypoint();
    return RouteState == TEXT("moving");
}

void ARidgeBotTestController::RequestCurrentWaypoint()
{
    if (!HasAuthority() || RouteState != TEXT("moving"))
    {
        return;
    }

    // AlreadyAtGoal can happen for consecutive waypoints. Iterate instead of
    // recursing so a large route cannot grow the call stack.
    while (Waypoints.IsValidIndex(WaypointIndex))
    {
        FAIMoveRequest MoveRequest(Waypoints[WaypointIndex]);
        MoveRequest.SetAcceptanceRadius(RouteAcceptanceRadius);
        MoveRequest.SetUsePathfinding(true);
        MoveRequest.SetProjectGoalLocation(true);
        MoveRequest.SetCanStrafe(false);
        MoveRequest.SetAllowPartialPath(false);
        MoveRequest.SetRequireNavigableEndLocation(true);
        MoveRequest.SetReachTestIncludesAgentRadius(true);
        const FPathFollowingRequestResult RequestResult = MoveTo(MoveRequest, nullptr);

        if (RequestResult.Code == EPathFollowingRequestResult::Failed)
        {
            MarkRouteTerminal(TEXT("failed"), TEXT("move_request_failed"));
            return;
        }
        if (RequestResult.Code == EPathFollowingRequestResult::AlreadyAtGoal)
        {
            WriteTelemetry(TEXT("waypoint_already_reached"));
            ++WaypointIndex;
            continue;
        }
        if (!RequestResult.MoveId.IsValid())
        {
            MarkRouteTerminal(TEXT("failed"), TEXT("move_request_returned_invalid_id"));
            return;
        }

        ActiveRequestId = RequestResult.MoveId;
        bHasActiveRequestId = true;
        LastObservedLocation = GetPawn() ? GetPawn()->GetActorLocation() : FVector::ZeroVector;
        LastProgressDistance = GetPawn() ? FVector::Dist(LastObservedLocation, Waypoints[WaypointIndex]) : TNumericLimits<float>::Max();
        StuckElapsedSeconds = 0.0f;
        WriteTelemetry(TEXT("waypoint_requested"));
        return;
    }

    MarkRouteTerminal(TEXT("completed"), TEXT("all_waypoints_reached"));
}

void ARidgeBotTestController::CancelTestRoute(const FString& Reason)
{
    if (!HasAuthority() || RouteState != TEXT("moving"))
    {
        WriteTelemetry(TEXT("cancel_ignored"), TEXT("no_active_route"));
        return;
    }
    MarkRouteTerminal(TEXT("cancelled"), Reason.IsEmpty() ? TEXT("unspecified") : Reason);
    StopMovement();
}

void ARidgeBotTestController::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);
    if (!HasAuthority() || RouteState != TEXT("moving") || !GetPawn() || !Waypoints.IsValidIndex(WaypointIndex))
    {
        return;
    }

    const FVector CurrentLocation = GetPawn()->GetActorLocation();
    const float CurrentDistance = FVector::Dist(CurrentLocation, Waypoints[WaypointIndex]);
    const float Progress = LastProgressDistance - CurrentDistance;
    if (Progress >= MinimumProgressCentimeters || FVector::Dist(CurrentLocation, LastObservedLocation) >= MinimumProgressCentimeters)
    {
        StuckElapsedSeconds = 0.0f;
        LastProgressDistance = CurrentDistance;
        LastObservedLocation = CurrentLocation;
    }
    else
    {
        StuckElapsedSeconds += DeltaSeconds;
    }

    TelemetryElapsedSeconds += DeltaSeconds;
    if (TelemetryElapsedSeconds >= TelemetrySampleIntervalSeconds)
    {
        TelemetryElapsedSeconds = 0.0f;
        WriteTelemetry(TEXT("movement_sample"));
    }

    if (StuckElapsedSeconds >= StuckTimeoutSeconds)
    {
        WriteTelemetry(TEXT("navigation_stall_detected"), TEXT("no_measurable_progress_within_timeout"));
        // Do not silently relabel the request as active or completed. Stop it and
        // expose a terminal failure for the harness to classify/retry explicitly.
        MarkRouteTerminal(TEXT("failed"), TEXT("stuck_timeout"));
        StopMovement();
    }
}

void ARidgeBotTestController::OnMoveCompleted(FAIRequestID RequestID, const FPathFollowingResult& Result)
{
    Super::OnMoveCompleted(RequestID, Result);
    if (!HasAuthority() || RouteState != TEXT("moving"))
    {
        return;
    }

    if (!bHasActiveRequestId || RequestID.GetID() != ActiveRequestId.GetID())
    {
        WriteTelemetry(TEXT("stale_move_completion_ignored"), TEXT("request_id_missing_or_does_not_match_active_route"));
        return;
    }
    bHasActiveRequestId = false;

    if (Result.Code == EPathFollowingResult::Success)
    {
        WriteTelemetry(TEXT("waypoint_reached"));
        ++WaypointIndex;
        RequestCurrentWaypoint();
    }
    else if (Result.Code == EPathFollowingResult::Aborted)
    {
        MarkRouteTerminal(TEXT("cancelled"), TEXT("path_following_aborted"));
    }
    else
    {
        MarkRouteTerminal(TEXT("failed"), TEXT("path_following_failed"));
    }
}

void ARidgeBotTestController::MarkRouteTerminal(const FString& NewState, const FString& Reason)
{
    RouteState = NewState;
    bHasActiveRequestId = false;
    LastRouteReason = Reason;
    StuckElapsedSeconds = 0.0f;
    WriteTelemetry(TEXT("route_terminal"), Reason);
}

void ARidgeBotTestController::WriteTelemetry(const TCHAR* EventName, const FString& Detail, const FHitResult* Hit, const FVector* NormalImpulse)
{
    if (!bWriteTelemetry || !HasAuthority() || bTelemetryFinalized)
    {
        return;
    }

    TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Missing;
    Json->SetStringField(TEXT("schema"), TEXT("ridge.botlab.telemetry.v1"));
    Json->SetStringField(TEXT("controller_session_id"), ControllerSessionId.ToString(EGuidFormats::Digits));
    Json->SetStringField(TEXT("route_id"), ActiveRouteId.IsValid() ? ActiveRouteId.ToString(EGuidFormats::Digits) : FString());
    Json->SetNumberField(TEXT("route_generation"), static_cast<double>(RouteGeneration));
    Json->SetNumberField(TEXT("active_request_id"), bHasActiveRequestId ? static_cast<double>(ActiveRequestId.GetID()) : -1.0);
    Json->SetStringField(TEXT("event"), EventName);
    Json->SetStringField(TEXT("route_state"), RouteState);
    Json->SetStringField(TEXT("detail"), Detail);
    Json->SetNumberField(TEXT("waypoint_index"), WaypointIndex);
    Json->SetNumberField(TEXT("stuck_elapsed_seconds"), StuckElapsedSeconds);
    Json->SetNumberField(TEXT("telemetry_sample_interval_seconds"), TelemetrySampleIntervalSeconds);
    if (Hit)
    {
        const FVector ImpactPoint = Hit->ImpactPoint;
        const FVector ImpactNormal = Hit->ImpactNormal;
        TArray<TSharedPtr<FJsonValue>> PointValues;
        PointValues.Add(MakeShared<FJsonValueNumber>(ImpactPoint.X));
        PointValues.Add(MakeShared<FJsonValueNumber>(ImpactPoint.Y));
        PointValues.Add(MakeShared<FJsonValueNumber>(ImpactPoint.Z));
        Json->SetArrayField(TEXT("collision_impact_point_cm"), PointValues);
        TArray<TSharedPtr<FJsonValue>> NormalValues;
        NormalValues.Add(MakeShared<FJsonValueNumber>(ImpactNormal.X));
        NormalValues.Add(MakeShared<FJsonValueNumber>(ImpactNormal.Y));
        NormalValues.Add(MakeShared<FJsonValueNumber>(ImpactNormal.Z));
        Json->SetArrayField(TEXT("collision_impact_normal"), NormalValues);
        Json->SetStringField(TEXT("collision_other_actor_class"), Hit->GetActor() ? Hit->GetActor()->GetClass()->GetName() : TEXT("unknown"));
        if (Hit->GetComponent())
        {
            Json->SetNumberField(TEXT("collision_object_channel"), static_cast<int32>(Hit->GetComponent()->GetCollisionObjectType()));
        }
        else
        {
            Json->SetField(TEXT("collision_object_channel"), MakeShared<FJsonValueNull>());
            Missing.Add(MakeShared<FJsonValueString>(TEXT("collision_object_channel")));
        }
        if (Hit->PhysMaterial.IsValid())
        {
            Json->SetStringField(TEXT("collision_physical_material"), Hit->PhysMaterial->GetName());
        }
        else
        {
            Json->SetField(TEXT("collision_physical_material"), MakeShared<FJsonValueNull>());
            Missing.Add(MakeShared<FJsonValueString>(TEXT("collision_physical_material")));
        }
        if (NormalImpulse)
        {
            Json->SetNumberField(TEXT("collision_normal_impulse_magnitude"), NormalImpulse->Size());
        }
        else
        {
            Json->SetField(TEXT("collision_normal_impulse_magnitude"), MakeShared<FJsonValueNull>());
            Missing.Add(MakeShared<FJsonValueString>(TEXT("collision_normal_impulse_magnitude")));
        }
    }

    UWorld* World = GetWorld();
    if (World)
    {
        Json->SetNumberField(TEXT("server_world_time_seconds"), World->GetTimeSeconds());
    }
    else
    {
        Json->SetField(TEXT("server_world_time_seconds"), MakeShared<FJsonValueNull>());
        Missing.Add(MakeShared<FJsonValueString>(TEXT("server_world_time_seconds")));
    }

    APawn* Pawn = GetPawn();
    if (Pawn)
    {
        const FVector Location = Pawn->GetActorLocation();
        const FRotator Rotation = Pawn->GetActorRotation();
        const FVector Velocity = Pawn->GetVelocity();
        TArray<TSharedPtr<FJsonValue>> PositionValues;
        PositionValues.Add(MakeShared<FJsonValueNumber>(Location.X));
        PositionValues.Add(MakeShared<FJsonValueNumber>(Location.Y));
        PositionValues.Add(MakeShared<FJsonValueNumber>(Location.Z));
        Json->SetArrayField(TEXT("actor_position_cm"), PositionValues);
        TArray<TSharedPtr<FJsonValue>> RotationValues;
        RotationValues.Add(MakeShared<FJsonValueNumber>(Rotation.Pitch));
        RotationValues.Add(MakeShared<FJsonValueNumber>(Rotation.Yaw));
        RotationValues.Add(MakeShared<FJsonValueNumber>(Rotation.Roll));
        Json->SetArrayField(TEXT("actor_rotation_deg"), RotationValues);
        Json->SetNumberField(TEXT("speed_cm_s"), Velocity.Size());
    }
    else
    {
        for (const TCHAR* Field : {TEXT("actor_position_cm"), TEXT("actor_rotation_deg"), TEXT("speed_cm_s")})
        {
            Json->SetField(Field, MakeShared<FJsonValueNull>());
            Missing.Add(MakeShared<FJsonValueString>(Field));
        }
    }

    ACharacter* Character = Cast<ACharacter>(Pawn);
    UCharacterMovementComponent* Movement = Character ? Character->GetCharacterMovement() : nullptr;
    if (Movement)
    {
        Json->SetNumberField(TEXT("movement_mode_id"), static_cast<int32>(Movement->MovementMode));
        Json->SetNumberField(TEXT("custom_movement_mode_id"), Movement->CustomMovementMode);
        Json->SetBoolField(TEXT("is_moving_on_ground"), Movement->IsMovingOnGround());
        Json->SetBoolField(TEXT("is_falling"), Movement->IsFalling());
        Json->SetBoolField(TEXT("is_crouching"), Movement->IsCrouching());
    }
    else
    {
        for (const TCHAR* Field : {TEXT("movement_mode_id"), TEXT("custom_movement_mode_id"), TEXT("is_moving_on_ground"), TEXT("is_falling"), TEXT("is_crouching")})
        {
            Json->SetField(Field, MakeShared<FJsonValueNull>());
            Missing.Add(MakeShared<FJsonValueString>(Field));
        }
    }

    UPathFollowingComponent* PathFollowing = GetPathFollowingComponent();
    if (PathFollowing)
    {
        const EPathFollowingStatus::Type Status = PathFollowing->GetStatus();
        const TCHAR* StatusName = Status == EPathFollowingStatus::Moving ? TEXT("moving") :
            Status == EPathFollowingStatus::Paused ? TEXT("paused") : TEXT("idle");
        Json->SetStringField(TEXT("nav_path_status"), StatusName);
        Json->SetBoolField(TEXT("nav_partial_path"), HasPartialPath());
    }
    else
    {
        Json->SetField(TEXT("nav_path_status"), MakeShared<FJsonValueNull>());
        Json->SetField(TEXT("nav_partial_path"), MakeShared<FJsonValueNull>());
        Missing.Add(MakeShared<FJsonValueString>(TEXT("nav_path_status")));
        Missing.Add(MakeShared<FJsonValueString>(TEXT("nav_partial_path")));
    }

    if (Waypoints.IsValidIndex(WaypointIndex))
    {
        const FVector Target = Waypoints[WaypointIndex];
        TArray<TSharedPtr<FJsonValue>> TargetValues;
        TargetValues.Add(MakeShared<FJsonValueNumber>(Target.X));
        TargetValues.Add(MakeShared<FJsonValueNumber>(Target.Y));
        TargetValues.Add(MakeShared<FJsonValueNumber>(Target.Z));
        Json->SetArrayField(TEXT("active_waypoint_cm"), TargetValues);
        if (Pawn)
        {
            Json->SetNumberField(TEXT("distance_to_waypoint_cm"), FVector::Dist(Pawn->GetActorLocation(), Target));
        }
    }
    else
    {
        Json->SetField(TEXT("active_waypoint_cm"), MakeShared<FJsonValueNull>());
        Json->SetField(TEXT("distance_to_waypoint_cm"), MakeShared<FJsonValueNull>());
        Missing.Add(MakeShared<FJsonValueString>(TEXT("active_waypoint_cm")));
        Missing.Add(MakeShared<FJsonValueString>(TEXT("distance_to_waypoint_cm")));
    }
    Json->SetArrayField(TEXT("observability_missing_fields"), Missing);

    FString Line;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Line);
    FJsonSerializer::Serialize(Json, Writer);
    Line += LINE_TERMINATOR;

    if (TelemetryFilePath.IsEmpty())
    {
        return;
    }
    FFileHelper::SaveStringToFile(Line, *TelemetryFilePath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM,
        &IFileManager::Get(), FILEWRITE_Append);
}
