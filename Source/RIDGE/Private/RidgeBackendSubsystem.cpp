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
    const FString Environment = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_ENV"));
    if (ApiBaseUrl.IsEmpty() && !Environment.Equals(TEXT("production"), ESearchCase::IgnoreCase))
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
    bShardRegistered = false;
    bRegistrationInFlight = false;
    bShutdownRequested = true;
    ServerToken.Reset();
    ServerId.Reset();
    Super::Deinitialize();
}

bool URidgeBackendSubsystem::EnsureServerConfiguration()
{
    const UWorld* World = GetWorld();
    if (!World || World->GetNetMode() == NM_Client)
    {
        return false;
    }

    const FString Environment = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_ENV"));
    const bool bProduction = Environment.Equals(TEXT("production"), ESearchCase::IgnoreCase);
    if (ApiBaseUrl.IsEmpty())
    {
        if (bProduction)
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] RIDGE_API_BASE_URL is required in production."));
            return false;
        }
        ApiBaseUrl = TEXT("http://127.0.0.1:8787");
    }
    if (bProduction && !ApiBaseUrl.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase))
    {
        UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Production API URL must use HTTPS; refusing to send the server token."));
        return false;
    }

    // Load the secret only inside a server/standalone world. Never put it in
    // Default*.ini, client builds, command-line arguments or logs.
    if (ServerToken.IsEmpty())
    {
        ServerToken = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_EVENT_TOKEN"));
    }
    return !ApiBaseUrl.IsEmpty() && !ServerToken.IsEmpty();
}

bool URidgeBackendSubsystem::RegisterDedicatedServer()
{
    if (bShutdownRequested)
    {
        return false;
    }
    if (bShardRegistered || bRegistrationInFlight)
    {
        return true;
    }
    if (!EnsureServerConfiguration())
    {
        UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Dedicated Server registration requires a server world and valid server environment configuration."));
        return false;
    }

    if (ServerId.IsEmpty())
    {
        FString Label = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_ID"));
        if (Label.IsEmpty())
        {
            Label = TEXT("ridge-server");
        }
        Label = Label.Left(40);
        for (int32 Index = 0; Index < Label.Len(); ++Index)
        {
            const TCHAR Character = Label[Index];
            const bool bAllowed =
                (Character >= TEXT('a') && Character <= TEXT('z')) ||
                (Character >= TEXT('A') && Character <= TEXT('Z')) ||
                (Character >= TEXT('0') && Character <= TEXT('9')) ||
                Character == TEXT('.') || Character == TEXT('_') ||
                Character == TEXT('-') || Character == TEXT(':');
            if (!bAllowed)
            {
                Label[Index] = TEXT('-');
            }
        }
        // A unique suffix makes this ID a process-instance ID, not a machine ID.
        ServerId = Label + TEXT("-") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    }

    ServerRegion = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_REGION"));
    if (ServerRegion.IsEmpty())
    {
        ServerRegion = TEXT("ge-tbilisi");
    }

    ServerHost = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_HOST"));
    const FString Environment = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_ENV"));
    if (ServerHost.IsEmpty())
    {
        if (Environment.Equals(TEXT("production"), ESearchCase::IgnoreCase))
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] RIDGE_SERVER_HOST is required in production; refusing to advertise a loopback address."));
            return false;
        }
        ServerHost = TEXT("127.0.0.1");
        UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] RIDGE_SERVER_HOST is not set; advertising development loopback 127.0.0.1."));
    }

    const FString PortValue = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_PORT"));
    if (!PortValue.IsEmpty())
    {
        ServerPort = FCString::Atoi(*PortValue);
        if (ServerPort < 1 || ServerPort > 65535 || FString::FromInt(ServerPort) != PortValue)
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] RIDGE_SERVER_PORT must be an integer between 1 and 65535."));
            return false;
        }
    }

    const FString MaxPlayersValue = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_SERVER_MAX_PLAYERS"));
    if (!MaxPlayersValue.IsEmpty())
    {
        ServerMaxPlayers = FCString::Atoi(*MaxPlayersValue);
        if (ServerMaxPlayers < 1 || ServerMaxPlayers > 250 || FString::FromInt(ServerMaxPlayers) != MaxPlayersValue)
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] RIDGE_SERVER_MAX_PLAYERS must be an integer between 1 and 250."));
            return false;
        }
    }

    ServerProtocolVersion = FPlatformMisc::GetEnvironmentVariable(TEXT("RIDGE_PROTOCOL_VERSION"));
    if (ServerProtocolVersion.IsEmpty())
    {
        ServerProtocolVersion = TEXT("ridge-0.6");
    }

    TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("serverId"), ServerId);
    Payload->SetStringField(TEXT("region"), ServerRegion);
    Payload->SetStringField(TEXT("host"), ServerHost);
    Payload->SetNumberField(TEXT("port"), ServerPort);
    Payload->SetNumberField(TEXT("maxPlayers"), ServerMaxPlayers);
    Payload->SetStringField(TEXT("protocolVersion"), ServerProtocolVersion);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(ApiBaseUrl + TEXT("/v1/internal/shards/register"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("x-ridge-server-token"), ServerToken);
    Request->SetContentAsString(RidgeSerializeJson(Payload));
    Request->SetTimeout(8.0f);

    bRegistrationInFlight = true;
    const TWeakObjectPtr<URidgeBackendSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakThis](FHttpRequestPtr Req, FHttpResponsePtr Response, bool bConnected)
    {
        URidgeBackendSubsystem* Self = WeakThis.Get();
        if (!Self) return;
        Self->bRegistrationInFlight = false;

        if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 201)
        {
            const int32 Code = Response.IsValid() ? Response->GetResponseCode() : 0;
            UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Dedicated Server registration failed (HTTP %d); retrying on next heartbeat."), Code);
            return;
        }

        TSharedPtr<FJsonObject> Json;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
        FString RegisteredServerId;
        if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid() ||
            !Json->TryGetStringField(TEXT("serverId"), RegisteredServerId) ||
            RegisteredServerId != Self->ServerId)
        {
            UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Shard registration response does not match this server instance."));
            return;
        }

        Self->bShardRegistered = true;
        if (Self->bShutdownRequested)
        {
            Self->SendShardHeartbeat(0, TEXT("offline"));
            return;
        }
        Self->LogServerMessage(FString::Printf(TEXT("Dedicated Server registered: %s (%s:%d, max %d)."),
            *Self->ServerId, *Self->ServerHost, Self->ServerPort, Self->ServerMaxPlayers));
    });

    if (!Request->ProcessRequest())
    {
        bRegistrationInFlight = false;
        UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Could not start Dedicated Server registration request."));
        return false;
    }
    return true;
}

void URidgeBackendSubsystem::SendShardHeartbeat(int32 CurrentPlayers, const FString& Status)
{
    if (!bShardRegistered || ServerToken.IsEmpty() || ApiBaseUrl.IsEmpty())
    {
        return;
    }
    if (CurrentPlayers < 0 || CurrentPlayers > ServerMaxPlayers ||
        (Status != TEXT("ready") && Status != TEXT("draining") && Status != TEXT("offline")))
    {
        UE_LOG(LogTemp, Error, TEXT("[RIDGE Backend] Shard heartbeat values are outside the configured bounds."));
        return;
    }

    TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetNumberField(TEXT("currentPlayers"), CurrentPlayers);
    Payload->SetStringField(TEXT("status"), Status);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(ApiBaseUrl + TEXT("/v1/internal/shards/") + ServerId + TEXT("/heartbeat"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("x-ridge-server-token"), ServerToken);
    Request->SetContentAsString(RidgeSerializeJson(Payload));
    Request->SetTimeout(8.0f);

    const TWeakObjectPtr<URidgeBackendSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakThis, Status](FHttpRequestPtr Req, FHttpResponsePtr Response, bool bConnected)
    {
        URidgeBackendSubsystem* Self = WeakThis.Get();
        if (!Self) return;
        if (!bConnected || !Response.IsValid() || !EHttpResponseCodes::IsOk(Response->GetResponseCode()))
        {
            const int32 Code = Response.IsValid() ? Response->GetResponseCode() : 0;
            if (Code == 404)
            {
                Self->bShardRegistered = false;
            }
            UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Shard heartbeat failed (HTTP %d)."), Code);
            return;
        }
        if (Status == TEXT("offline"))
        {
            Self->bShardRegistered = false;
            Self->LogServerMessage(TEXT("Dedicated Server marked offline."));
        }
    });

    if (!Request->ProcessRequest())
    {
        UE_LOG(LogTemp, Warning, TEXT("[RIDGE Backend] Could not start shard heartbeat request."));
    }
}

void URidgeBackendSubsystem::MarkDedicatedServerOffline(int32 CurrentPlayers)
{
    bShutdownRequested = true;
    if (bShardRegistered)
    {
        SendShardHeartbeat(FMath::Clamp(CurrentPlayers, 0, ServerMaxPlayers), TEXT("offline"));
    }
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