#include "RidgeBackendSubsystem.h"

#include "Dom/JsonObject.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Guid.h"
#include "Misc/Parse.h"
#include "GenericPlatform/GenericPlatformMisc.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#ifdef GetEnvironmentVariable
#undef GetEnvironmentVariable
#endif
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    FString RidgeSerializeJson(const TSharedRef<FJsonObject>& JsonObject)
    {
        FString Output;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
        FJsonSerializer::Serialize(JsonObject, Writer);
        return Output;
    }
}

void URidgeBackendSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    ApiBaseUrl = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_API_BASE_URL"));
    if (ApiBaseUrl.IsEmpty())
    {
        ApiBaseUrl = TEXT("http://127.0.0.1:8787");
    }
    while (ApiBaseUrl.EndsWith(TEXT("/")))
    {
        ApiBaseUrl.LeftChopInline(1);
    }

    // The shared secret is loaded lazily only after a server-world check.
    // A client process must never copy an inherited server token into game memory.
}

void URidgeBackendSubsystem::Deinitialize()
{
    ActiveJobs.Empty();
    PendingAccepts.Empty();
    ServerToken.Reset();
    Super::Deinitialize();
}

bool URidgeBackendSubsystem::EnsureServerConfiguration()
{
    const UWorld* World = GetWorld();
    if (!World || World->GetNetMode() == NM_Client)
    {
        return false;
    }

    if (ApiBaseUrl.IsEmpty())
    {
        ApiBaseUrl = TEXT("http://127.0.0.1:8787");
    }

    // Load the secret only inside a server/standalone world. Never put it in
    // Default*.ini, client builds, command-line arguments or logs.
    if (ServerToken.IsEmpty())
    {
        ServerToken = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_EVENT_TOKEN"));
    }
    return !ApiBaseUrl.IsEmpty() && !ServerToken.IsEmpty();
}

void URidgeBackendSubsystem::LogServerMessage(const FString& Message) const
{
    UE_LOG(LogTemp, Log, TEXT("[RIDGE Backend] %s"), *Message);
}

void URidgeBackendSubsystem::AcceptDeliveryJob(const FString& PlayerId)
{
    if (PlayerId.IsEmpty() || PendingAccepts.Contains(PlayerId) || ActiveJobs.Contains(PlayerId))
    {
        return;
    }
    if (!EnsureServerConfiguration())
    {
        UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Job acceptance requires a server world and server environment configuration."));
        return;
    }

    PendingAccepts.Add(PlayerId);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(ApiBaseUrl + TEXT("/v1/internal/players/") + FGenericPlatformHttp::UrlEncode(PlayerId) + TEXT("/jobs/accept"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("x-ridge-server-token"), ServerToken);
    Request->SetContentAsString(TEXT("{\"definitionId\":\"delivery_intro\"}"));
    Request->SetTimeout(8.0f);
    const TWeakObjectPtr<URidgeBackendSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakThis, PlayerId](FHttpRequestPtr Req, FHttpResponsePtr Response, bool bConnected)
    {
        URidgeBackendSubsystem* Self = WeakThis.Get();
        if (!Self) return;
        Self->PendingAccepts.Remove(PlayerId);
        if (!bConnected || !Response.IsValid() || !EHttpResponseCodes::IsOk(Response->GetResponseCode()))
        {
            const int32 Code = Response.IsValid() ? Response->GetResponseCode() : 0;
            UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Job acceptance failed for player %s (HTTP %d)."), *PlayerId, Code);
            return;
        }

        TSharedPtr<FJsonObject> Json;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
        if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Invalid job acceptance response."));
            return;
        }

        FActiveDeliveryJob Job;
        Json->TryGetStringField(TEXT("id"), Job.JobId);
        Json->TryGetStringField(TEXT("completionProof"), Job.CompletionProof);
        const TArray<TSharedPtr<FJsonValue>>* Checkpoints = nullptr;
        if (Json->TryGetArrayField(TEXT("requiredCheckpoints"), Checkpoints) && Checkpoints)
        {
            Job.RequiredCount = Checkpoints->Num();
        }

        if (Job.JobId.IsEmpty() || Job.CompletionProof.IsEmpty() || Job.RequiredCount <= 0)
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Job response is missing required fields."));
            return;
        }

        Self->ActiveJobs.Add(PlayerId, MoveTemp(Job));
        Self->LogServerMessage(FString::Printf(TEXT("Delivery job accepted for player %s."), *PlayerId));
    });

    if (!Request->ProcessRequest())
    {
        PendingAccepts.Remove(PlayerId);
        UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Could not start job acceptance request."));
    }
}

void URidgeBackendSubsystem::RecordDeliveryCheckpoint(const FString& PlayerId, const FString& CheckpointId, const FVector& ObservedPositionMeters)
{
    FActiveDeliveryJob* Job = ActiveJobs.Find(PlayerId);
    if (!Job || Job->bCompleting || CheckpointId.IsEmpty() || !EnsureServerConfiguration())
    {
        return;
    }

    const FString JobId = Job->JobId;
    const FString EventId = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    TSharedRef<FJsonObject> CheckpointPayload = MakeShared<FJsonObject>();
    CheckpointPayload->SetStringField(TEXT("playerId"), PlayerId);
    CheckpointPayload->SetStringField(TEXT("checkpointId"), CheckpointId);
    CheckpointPayload->SetStringField(TEXT("serverEventId"), EventId);
    TSharedPtr<FJsonObject> ObservedPosition = MakeShared<FJsonObject>();
    ObservedPosition->SetNumberField(TEXT("x"), ObservedPositionMeters.X);
    ObservedPosition->SetNumberField(TEXT("y"), ObservedPositionMeters.Y);
    ObservedPosition->SetNumberField(TEXT("z"), ObservedPositionMeters.Z);
    CheckpointPayload->SetObjectField(TEXT("observedPosition"), ObservedPosition);
    const FString Body = RidgeSerializeJson(CheckpointPayload);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(ApiBaseUrl + TEXT("/v1/internal/jobs/") + JobId + TEXT("/checkpoints"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("x-ridge-server-token"), ServerToken);
    Request->SetContentAsString(Body);
    Request->SetTimeout(8.0f);
    const TWeakObjectPtr<URidgeBackendSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakThis, PlayerId, CheckpointId](FHttpRequestPtr Req, FHttpResponsePtr Response, bool bConnected)
    {
        URidgeBackendSubsystem* Self = WeakThis.Get();
        if (!Self) return;
        if (!bConnected || !Response.IsValid() || !EHttpResponseCodes::IsOk(Response->GetResponseCode()))
        {
            const int32 Code = Response.IsValid() ? Response->GetResponseCode() : 0;
            UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Checkpoint %s failed for player %s (HTTP %d)."), *CheckpointId, *PlayerId, Code);
            return;
        }

        TSharedPtr<FJsonObject> Json;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
        if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
        {
            return;
        }
        if (FActiveDeliveryJob* Current = Self->ActiveJobs.Find(PlayerId))
        {
            double CompletedCount = 0.0;
            double RequiredCount = 0.0;
            Json->TryGetNumberField(TEXT("completedCount"), CompletedCount);
            Json->TryGetNumberField(TEXT("requiredCount"), RequiredCount);
            Current->CompletedCount = static_cast<int32>(CompletedCount);
            Current->RequiredCount = static_cast<int32>(RequiredCount);
            Self->LogServerMessage(FString::Printf(TEXT("Checkpoint %s recorded (%d/%d) for player %s."),
                *CheckpointId, Current->CompletedCount, Current->RequiredCount, *PlayerId));
            if (Current->RequiredCount > 0 && Current->CompletedCount >= Current->RequiredCount)
            {
                Self->CompleteDeliveryJob(PlayerId);
            }
        }
    });

    if (!Request->ProcessRequest())
    {
        UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Could not start checkpoint request."));
    }
}

void URidgeBackendSubsystem::CompleteDeliveryJob(const FString& PlayerId)
{
    FActiveDeliveryJob* Job = ActiveJobs.Find(PlayerId);
    if (!Job || Job->bCompleting)
    {
        return;
    }
    Job->bCompleting = true;

    TSharedRef<FJsonObject> CompletionPayload = MakeShared<FJsonObject>();
    CompletionPayload->SetStringField(TEXT("playerId"), PlayerId);
    CompletionPayload->SetStringField(TEXT("completionProof"), Job->CompletionProof);
    const FString Body = RidgeSerializeJson(CompletionPayload);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(ApiBaseUrl + TEXT("/v1/internal/jobs/") + Job->JobId + TEXT("/complete"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("x-ridge-server-token"), ServerToken);
    Request->SetContentAsString(Body);
    Request->SetTimeout(8.0f);
    const TWeakObjectPtr<URidgeBackendSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakThis, PlayerId](FHttpRequestPtr Req, FHttpResponsePtr Response, bool bConnected)
    {
        URidgeBackendSubsystem* Self = WeakThis.Get();
        if (!Self) return;
        if (!bConnected || !Response.IsValid() || !EHttpResponseCodes::IsOk(Response->GetResponseCode()))
        {
            if (FActiveDeliveryJob* Current = Self->ActiveJobs.Find(PlayerId))
            {
                Current->bCompleting = false;
            }
            const int32 Code = Response.IsValid() ? Response->GetResponseCode() : 0;
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Job completion failed for player %s (HTTP %d)."), *PlayerId, Code);
            return;
        }

        TSharedPtr<FJsonObject> Json;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
        if (FJsonSerializer::Deserialize(Reader, Json) && Json.IsValid())
        {
            FString Reward;
            FString Balance;
            Json->TryGetStringField(TEXT("reward"), Reward);
            Json->TryGetStringField(TEXT("balance"), Balance);
            Self->LogServerMessage(FString::Printf(TEXT("Player %s completed delivery. Reward: %s GEL; balance: %s GEL."),
                *PlayerId, *Reward, *Balance));
            Self->ActiveJobs.Remove(PlayerId);
        }
    });

    if (!Request->ProcessRequest())
    {
        if (FActiveDeliveryJob* Current = ActiveJobs.Find(PlayerId))
        {
            Current->bCompleting = false;
        }
    }
}