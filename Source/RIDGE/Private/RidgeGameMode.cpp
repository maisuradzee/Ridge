#include "RidgeGameMode.h"
#include "RidgeBackendSubsystem.h"
#include "RidgeCharacter.h"
#include "RidgeGameState.h"
#include "RidgePlayerState.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GameFramework/Controller.h"
#include "GameFramework/GameSession.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"
#include "GenericPlatform/GenericPlatformMisc.h"
#include "TimerManager.h"

ARidgeGameMode::ARidgeGameMode()
{
    DefaultPawnClass = ARidgeCharacter::StaticClass();
    GameStateClass = ARidgeGameState::StaticClass();
    PlayerStateClass = ARidgePlayerState::StaticClass();
}

bool ARidgeGameMode::ShouldRequireJoinTicket() const
{
    if (GetWorld() && GetWorld()->GetNetMode() == NM_DedicatedServer)
    {
        return true;
    }

    const FString Environment = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_ENV"));
    return Environment.Equals(TEXT("production"), ESearchCase::IgnoreCase);
}


bool ARidgeGameMode::HasPlayerJoinInFlight(const FString& PlayerId) const
{
    if (PlayerId.IsEmpty())
    {
        return true;
    }

    for (const TPair<FString, FVerifiedJoinClaim>& Entry : VerifiedClaimsByTicket)
    {
        if (Entry.Value.PlayerId == PlayerId)
        {
            return true;
        }
    }
    for (const TPair<TWeakObjectPtr<AController>, FVerifiedJoinClaim>& Entry : PendingJoinClaimsByController)
    {
        if (Entry.Value.PlayerId == PlayerId)
        {
            return true;
        }
    }
    for (const TPair<TWeakObjectPtr<AController>, FVerifiedJoinClaim>& Entry : ActiveJoinClaimsByController)
    {
        if (Entry.Value.PlayerId == PlayerId)
        {
            return true;
        }
    }
    return false;
}

void ARidgeGameMode::PreLoginAsync(
    const FString& Options,
    const FString& Address,
    const FUniqueNetIdRepl& UniqueId,
    const FOnPreLoginCompleteDelegate& OnComplete)
{
    const TWeakObjectPtr<ARidgeGameMode> WeakThis(this);
    const FOnPreLoginCompleteDelegate Completion = OnComplete;

    // Preserve the engine's normal PreLogin checks and GameModePreLoginEvent.
    Super::PreLoginAsync(
        Options,
        Address,
        UniqueId,
        FOnPreLoginCompleteDelegate::CreateLambda(
            [WeakThis, Options, Completion](const FString& BaseError) mutable
            {
                if (!BaseError.IsEmpty())
                {
                    Completion.ExecuteIfBound(BaseError);
                    return;
                }

                ARidgeGameMode* Self = WeakThis.Get();
                if (!Self)
                {
                    Completion.ExecuteIfBound(TEXT("RIDGE server is shutting down."));
                    return;
                }

                if (!Self->ShouldRequireJoinTicket())
                {
                    Completion.ExecuteIfBound(FString());
                    return;
                }

                const FString Ticket = UGameplayStatics::ParseOption(Options, TEXT("ridgeJoinTicket"));
                const FString ClaimAttemptId = UGameplayStatics::ParseOption(Options, TEXT("ridgeClaimAttemptId"));
                if (Ticket.IsEmpty() || ClaimAttemptId.IsEmpty())
                {
                    Completion.ExecuteIfBound(TEXT("A valid RIDGE join ticket and claim attempt ID are required."));
                    return;
                }

                UGameInstance* GameInstance = Self->GetGameInstance();
                URidgeBackendSubsystem* Backend = GameInstance
                    ? GameInstance->GetSubsystem<URidgeBackendSubsystem>()
                    : nullptr;
                if (!Backend || !Backend->IsDedicatedServerRegistered())
                {
                    Completion.ExecuteIfBound(TEXT("RIDGE server session registry is unavailable."));
                    return;
                }

                Backend->ClaimJoinTicket(
                    Ticket,
                    ClaimAttemptId,
                    [WeakThis, Ticket, ClaimAttemptId, Completion](bool bSuccess,
                                                   const FString& PlayerId,
                                                   const FString& SessionId,
                                                   const FString& ErrorMessage) mutable
                    {
                        ARidgeGameMode* Current = WeakThis.Get();
                        if (!Current)
                        {
                            Completion.ExecuteIfBound(TEXT("RIDGE server is no longer available."));
                            return;
                        }

                        if (!bSuccess || PlayerId.IsEmpty() || SessionId.IsEmpty())
                        {
                            Completion.ExecuteIfBound(
                                ErrorMessage.IsEmpty()
                                    ? TEXT("RIDGE join ticket verification failed.")
                                    : ErrorMessage);
                            return;
                        }

                        if (const FVerifiedJoinClaim* ExistingTicketClaim = Current->VerifiedClaimsByTicket.Find(Ticket))
                        {
                            if (ExistingTicketClaim->PlayerId == PlayerId &&
                                ExistingTicketClaim->ClaimAttemptId == ClaimAttemptId)
                            {
                                // Same ticket + same attempt: safe retry before InitNewPlayer consumes the claim.
                                Completion.ExecuteIfBound(FString());
                                return;
                            }
                        }

                        if (Current->HasPlayerJoinInFlight(PlayerId))
                        {
                            Completion.ExecuteIfBound(TEXT("This RIDGE account already has a pending or active connection."));
                            return;
                        }

                        FVerifiedJoinClaim Claim;
                        Claim.PlayerId = PlayerId;
                        Claim.SessionId = SessionId;
                        Claim.ClaimAttemptId = ClaimAttemptId;
                        Claim.ExpiresAtUtc = FDateTime::UtcNow() + FTimespan::FromSeconds(25.0);
                        Current->VerifiedClaimsByTicket.Add(Ticket, MoveTemp(Claim));
                        Completion.ExecuteIfBound(FString());
                    });
            }));
}

FString ARidgeGameMode::InitNewPlayer(
    APlayerController* NewPlayerController,
    const FUniqueNetIdRepl& UniqueId,
    const FString& Options,
    const FString& Portal)
{
    const FString BaseError = Super::InitNewPlayer(NewPlayerController, UniqueId, Options, Portal);
    const FString Ticket = UGameplayStatics::ParseOption(Options, TEXT("ridgeJoinTicket"));

    FVerifiedJoinClaim* VerifiedClaim = Ticket.IsEmpty()
        ? nullptr
        : VerifiedClaimsByTicket.Find(Ticket);

    if (!BaseError.IsEmpty())
    {
        if (VerifiedClaim)
        {
            ReleaseJoinClaim(*VerifiedClaim);
            VerifiedClaimsByTicket.Remove(Ticket);
        }
        return BaseError;
    }

    if (!ShouldRequireJoinTicket())
    {
        return FString();
    }

    if (!NewPlayerController || !VerifiedClaim)
    {
        return TEXT("RIDGE join ticket verification is missing or expired.");
    }

    if (VerifiedClaim->ExpiresAtUtc <= FDateTime::UtcNow())
    {
        ReleaseJoinClaim(*VerifiedClaim);
        VerifiedClaimsByTicket.Remove(Ticket);
        return TEXT("RIDGE join ticket expired. Request a new session ticket.");
    }

    PendingJoinClaimsByController.Add(TWeakObjectPtr<AController>(NewPlayerController), *VerifiedClaim);
    VerifiedClaimsByTicket.Remove(Ticket);
    return FString();
}

void ARidgeGameMode::PostLogin(APlayerController* NewPlayer)
{
    Super::PostLogin(NewPlayer);

    if (!NewPlayer)
    {
        return;
    }

    const TWeakObjectPtr<AController> ControllerKey(NewPlayer);
    FVerifiedJoinClaim* PendingClaim = PendingJoinClaimsByController.Find(ControllerKey);
    if (!PendingClaim)
    {
        if (ShouldRequireJoinTicket())
        {
            UE_LOG(LogTemp, Warning, TEXT("[RIDGE Auth] PostLogin rejected: no verified session claim."));
            if (!GameSession || !GameSession->KickPlayer(NewPlayer, FText::FromString(TEXT("RIDGE join ticket verification is required."))))
            {
                NewPlayer->Destroy();
            }
        }
        return;
    }

    const FVerifiedJoinClaim Claim = *PendingClaim;
    PendingJoinClaimsByController.Remove(ControllerKey);

    if (Claim.ExpiresAtUtc <= FDateTime::UtcNow())
    {
        UE_LOG(LogTemp, Warning, TEXT("[RIDGE Auth] PostLogin rejected: pending join claim expired."));
        ReleaseJoinClaim(Claim);
        if (!GameSession || !GameSession->KickPlayer(NewPlayer, FText::FromString(TEXT("RIDGE join ticket expired."))))
        {
            NewPlayer->Destroy();
        }
        return;
    }

    ARidgePlayerState* RidgeState = NewPlayer->GetPlayerState<ARidgePlayerState>();
    if (!RidgeState || !RidgeState->SetVerifiedPlayerId(Claim.PlayerId))
    {
        UE_LOG(LogTemp, Error, TEXT("[RIDGE Auth] PostLogin rejected: verified PlayerState identity could not be applied."));
        ReleaseJoinClaim(Claim);
        if (!GameSession || !GameSession->KickPlayer(NewPlayer, FText::FromString(TEXT("RIDGE verified player identity could not be applied."))))
        {
            NewPlayer->Destroy();
        }
        return;
    }

    ActiveJoinClaimsByController.Add(ControllerKey, Claim);
}

void ARidgeGameMode::Logout(AController* Exiting)
{
    if (Exiting)
    {
        const TWeakObjectPtr<AController> ControllerKey(Exiting);
        if (FVerifiedJoinClaim* ActiveClaim = ActiveJoinClaimsByController.Find(ControllerKey))
        {
            ReleaseJoinClaim(*ActiveClaim);
            ActiveJoinClaimsByController.Remove(ControllerKey);
        }
        if (FVerifiedJoinClaim* PendingClaim = PendingJoinClaimsByController.Find(ControllerKey))
        {
            ReleaseJoinClaim(*PendingClaim);
            PendingJoinClaimsByController.Remove(ControllerKey);
        }
    }

    Super::Logout(Exiting);
}

void ARidgeGameMode::ReleaseJoinClaim(const FVerifiedJoinClaim& Claim)
{
    if (UGameInstance* GameInstance = GetGameInstance())
    {
        if (URidgeBackendSubsystem* Backend = GameInstance->GetSubsystem<URidgeBackendSubsystem>())
        {
            Backend->ReleasePlayerSession(Claim.PlayerId, Claim.SessionId);
        }
    }
}

void ARidgeGameMode::PruneExpiredJoinClaims()
{
    const FDateTime Now = FDateTime::UtcNow();

    for (auto It = VerifiedClaimsByTicket.CreateIterator(); It; ++It)
    {
        if (It.Value().ExpiresAtUtc <= Now)
        {
            ReleaseJoinClaim(It.Value());
            It.RemoveCurrent();
        }
    }

    for (auto It = PendingJoinClaimsByController.CreateIterator(); It; ++It)
    {
        if (!It.Key().IsValid() || It.Value().ExpiresAtUtc <= Now)
        {
            ReleaseJoinClaim(It.Value());
            It.RemoveCurrent();
        }
    }
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

    GetWorld()->GetTimerManager().SetTimer(
        JoinClaimCleanupTimer,
        this,
        &ARidgeGameMode::PruneExpiredJoinClaims,
        5.0f,
        true,
        5.0f);
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
        World->GetTimerManager().ClearTimer(JoinClaimCleanupTimer);
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

    for (const TPair<FString, FVerifiedJoinClaim>& Entry : VerifiedClaimsByTicket)
    {
        ReleaseJoinClaim(Entry.Value);
    }
    VerifiedClaimsByTicket.Empty();

    for (const TPair<TWeakObjectPtr<AController>, FVerifiedJoinClaim>& Entry : PendingJoinClaimsByController)
    {
        ReleaseJoinClaim(Entry.Value);
    }
    PendingJoinClaimsByController.Empty();

    ActiveJoinClaimsByController.Empty();

    Super::EndPlay(EndPlayReason);
}
