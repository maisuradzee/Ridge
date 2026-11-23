#include "RidgeSessionLoginSubsystem.h"

#include "Dom/JsonObject.h"
#include "GameFramework/PlayerController.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Guid.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    FString SerializeSessionLoginJson(const TSharedRef<FJsonObject>& Json)
    {
        FString Output;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
        FJsonSerializer::Serialize(Json, Writer);
        return Output;
    }
}

void URidgeSessionLoginSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    if (GConfig)
    {
        GConfig->GetString(
            TEXT("RidgeSessionLogin"),
            TEXT("GatewayBaseUrl"),
            GatewayBaseUrl,
            GGameIni);
    }

    while (GatewayBaseUrl.EndsWith(TEXT("/")))
    {
        GatewayBaseUrl.LeftChopInline(1);
    }
}

void URidgeSessionLoginSubsystem::RequestAndConnectFromBlueprint(
    const FString& OidcAccessToken,
    const FString& Region,
    APlayerController* LocalPlayerController)
{
    const TWeakObjectPtr<URidgeSessionLoginSubsystem> WeakThis(this);
    RequestAndConnect(
        OidcAccessToken,
        Region,
        LocalPlayerController,
        [WeakThis](bool bTravelStarted, const FString& Message)
        {
            if (URidgeSessionLoginSubsystem* Self = WeakThis.Get())
            {
                Self->OnLoginAttemptCompleted.Broadcast(bTravelStarted, Message);
            }
        });
}

bool URidgeSessionLoginSubsystem::IsGatewayTransportAllowed() const
{
    if (GatewayBaseUrl.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase))
    {
        return true;
    }

    // Plain HTTP is deliberately limited to exact loopback authorities. Do not
    // use StartsWith(host): values such as localhost.attacker.example are public.
    if (!GatewayBaseUrl.StartsWith(TEXT("http://"), ESearchCase::IgnoreCase))
    {
        return false;
    }

    const FString Authority = GatewayBaseUrl.RightChop(7);
    if (Authority.Contains(TEXT("/")) || Authority.Contains(TEXT("?")) ||
        Authority.Contains(TEXT("#")) || Authority.Contains(TEXT("@")))
    {
        return false;
    }

    const TCHAR* LoopbackHosts[] = { TEXT("127.0.0.1"), TEXT("localhost"), TEXT("[::1]") };
    for (const TCHAR* LoopbackHost : LoopbackHosts)
    {
        const FString Host(LoopbackHost);
        if (Authority == Host)
        {
            return true;
        }
        if (Authority.StartsWith(Host + TEXT(":")))
        {
            const FString PortText = Authority.RightChop(Host.Len() + 1);
            if (PortText.IsEmpty())
            {
                return false;
            }
            for (const TCHAR Character : PortText)
            {
                if (Character < TEXT('0') || Character > TEXT('9'))
                {
                    return false;
                }
            }
            const int32 Port = FCString::Atoi(*PortText);
            return Port >= 1 && Port <= 65535 && FString::FromInt(Port) == PortText;
        }
    }
    return false;
}

bool URidgeSessionLoginSubsystem::IsValidRegion(const FString& Region)
{
    if (Region.IsEmpty() || Region.Len() > 64)
    {
        return false;
    }

    for (const TCHAR Character : Region)
    {
        const bool bAllowed =
            (Character >= TEXT('a') && Character <= TEXT('z')) ||
            (Character >= TEXT('A') && Character <= TEXT('Z')) ||
            (Character >= TEXT('0') && Character <= TEXT('9')) ||
            Character == TEXT('.') || Character == TEXT('_') ||
            Character == TEXT('-') || Character == TEXT(':');
        if (!bAllowed)
        {
            return false;
        }
    }
    return true;
}

bool URidgeSessionLoginSubsystem::IsValidJoinTicket(const FString& Ticket)
{
    if (Ticket.Len() != 43)
    {
        return false;
    }
    for (const TCHAR Character : Ticket)
    {
        const bool bAllowed =
            (Character >= TEXT('a') && Character <= TEXT('z')) ||
            (Character >= TEXT('A') && Character <= TEXT('Z')) ||
            (Character >= TEXT('0') && Character <= TEXT('9')) ||
            Character == TEXT('_') || Character == TEXT('-');
        if (!bAllowed)
        {
            return false;
        }
    }
    return true;
}

bool URidgeSessionLoginSubsystem::IsValidServerHost(const FString& Host)
{
    if (Host.IsEmpty() || Host.Len() > 253 || Host.StartsWith(TEXT(".")) ||
        Host.EndsWith(TEXT(".")) || Host.Contains(TEXT("..")))
    {
        return false;
    }

    for (const TCHAR Character : Host)
    {
        const bool bAllowed =
            (Character >= TEXT('a') && Character <= TEXT('z')) ||
            (Character >= TEXT('A') && Character <= TEXT('Z')) ||
            (Character >= TEXT('0') && Character <= TEXT('9')) ||
            Character == TEXT('.') || Character == TEXT('-');
        if (!bAllowed)
        {
            return false;
        }
    }
    return true;
}

void URidgeSessionLoginSubsystem::RequestAndConnect(
    const FString& OidcAccessToken,
    const FString& Region,
    APlayerController* LocalPlayerController,
    TFunction<void(bool, const FString&)> Completion)
{
    const TSharedRef<TFunction<void(bool, const FString&)>> CompletionRef =
        MakeShared<TFunction<void(bool, const FString&)>>(MoveTemp(Completion));
    const auto Finish = [CompletionRef](bool bSuccess, const FString& Message)
    {
        if (CompletionRef->IsSet())
        {
            TFunction<void(bool, const FString&)> Callback = MoveTemp(*CompletionRef);
            Callback(bSuccess, Message);
        }
    };

    if (bRequestInFlight)
    {
        Finish(false, TEXT("RIDGE login მოთხოვნა უკვე მიმდინარეობს."));
        return;
    }
    if (!LocalPlayerController || !LocalPlayerController->IsLocalController())
    {
        Finish(false, TEXT("ადგილობრივი PlayerController ვერ მოიძებნა."));
        return;
    }
    if (OidcAccessToken.IsEmpty() || OidcAccessToken.Len() > 16'384 ||
        OidcAccessToken.Contains(TEXT("\r")) || OidcAccessToken.Contains(TEXT("\n")))
    {
        Finish(false, TEXT("OIDC access token არასწორია ან ზედმეტად დიდია."));
        return;
    }
    if (!IsGatewayTransportAllowed() || GatewayBaseUrl.IsEmpty())
    {
        Finish(false, TEXT("RIDGE Gateway-ის HTTPS მისამართი არასწორად არის კონფიგურირებული."));
        return;
    }

    const FString SelectedRegion = Region.IsEmpty() ? TEXT("ge-tbilisi") : Region;
    if (!IsValidRegion(SelectedRegion))
    {
        Finish(false, TEXT("RIDGE region ID არასწორია."));
        return;
    }

    TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("region"), SelectedRegion);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(GatewayBaseUrl + TEXT("/v1/gateway/session"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("Accept"), TEXT("application/json"));
    Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + OidcAccessToken);
    Request->SetContentAsString(SerializeSessionLoginJson(Payload));
    Request->SetTimeout(10.0f);

    bRequestInFlight = true;
    const TWeakObjectPtr<URidgeSessionLoginSubsystem> WeakThis(this);
    const TWeakObjectPtr<APlayerController> WeakController(LocalPlayerController);

    Request->OnProcessRequestComplete().BindLambda(
        [WeakThis, WeakController, CompletionRef](
            FHttpRequestPtr HttpRequest,
            FHttpResponsePtr Response,
            bool bConnected) mutable
        {
            URidgeSessionLoginSubsystem* Self = WeakThis.Get();
            if (!Self)
            {
                if (CompletionRef->IsSet())
                {
                    TFunction<void(bool, const FString&)> Callback = MoveTemp(*CompletionRef);
                    Callback(false, TEXT("RIDGE login subsystem აღარ არის ხელმისაწვდომი."));
                }
                return;
            }

            Self->bRequestInFlight = false;
            const auto FinishRequest = [CompletionRef](bool bSuccess, const FString& Message)
            {
                if (CompletionRef->IsSet())
                {
                    TFunction<void(bool, const FString&)> Callback = MoveTemp(*CompletionRef);
                    Callback(bSuccess, Message);
                }
            };

            if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 201)
            {
                FinishRequest(false, TEXT("RIDGE Gateway-მა session ვერ გასცა. თავიდან გაიარე ავტორიზაცია ან სცადე მოგვიანებით."));
                return;
            }

            const TArray<uint8>& Content = Response->GetContent();
            if (Content.Num() == 0 || Content.Num() > 16 * 1024)
            {
                FinishRequest(false, TEXT("RIDGE Gateway-ის პასუხის ზომა არასწორია."));
                return;
            }

            TSharedPtr<FJsonObject> Json;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
            if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
            {
                FinishRequest(false, TEXT("RIDGE Gateway-ის პასუხი ვერ დამუშავდა."));
                return;
            }

            const TSharedPtr<FJsonObject>* ServerObject = nullptr;
            const TSharedPtr<FJsonObject>* JoinObject = nullptr;
            FString Host;
            FString Ticket;
            FString ClaimAttemptId;
            FString ExpiresAt;
            double PortValue = 0.0;
            if (!Json->TryGetObjectField(TEXT("server"), ServerObject) || !ServerObject || !ServerObject->IsValid() ||
                !Json->TryGetObjectField(TEXT("join"), JoinObject) || !JoinObject || !JoinObject->IsValid() ||
                !(*ServerObject)->TryGetStringField(TEXT("host"), Host) ||
                !(*ServerObject)->TryGetNumberField(TEXT("port"), PortValue) ||
                !(*JoinObject)->TryGetStringField(TEXT("ticket"), Ticket) ||
                !(*JoinObject)->TryGetStringField(TEXT("claimAttemptId"), ClaimAttemptId) ||
                !Json->TryGetStringField(TEXT("expiresAt"), ExpiresAt))
            {
                FinishRequest(false, TEXT("RIDGE Gateway-ის session პასუხში სავალდებულო ველები აკლია."));
                return;
            }

            FGuid ParsedClaimAttempt;
            FDateTime ExpiryUtc;
            if (!IsValidServerHost(Host) ||
                PortValue < 1.0 || PortValue > 65535.0 ||
                !FMath::IsNearlyEqual(PortValue, static_cast<double>(static_cast<int32>(PortValue))) ||
                !IsValidJoinTicket(Ticket) ||
                !FGuid::Parse(ClaimAttemptId, ParsedClaimAttempt) ||
                !FDateTime::ParseIso8601(*ExpiresAt, ExpiryUtc) ||
                ExpiryUtc <= FDateTime::UtcNow())
            {
                FinishRequest(false, TEXT("RIDGE Gateway-ის session მონაცემები არასწორია ან ვადაგასულია."));
                return;
            }

            APlayerController* PlayerController = WeakController.Get();
            if (!PlayerController || !PlayerController->IsLocalController())
            {
                FinishRequest(false, TEXT("ადგილობრივი მოთამაშე დაკავშირებამდე აღარ არის ხელმისაწვდომი."));
                return;
            }

            // Never log this URL: it contains a short-lived bearer join ticket.
            const FString ConnectUrl =
                Host + TEXT(":") + FString::FromInt(static_cast<int32>(PortValue)) +
                TEXT("?ridgeJoinTicket=") + FGenericPlatformHttp::UrlEncode(Ticket) +
                TEXT("?ridgeClaimAttemptId=") + FGenericPlatformHttp::UrlEncode(ClaimAttemptId);

            PlayerController->ClientTravel(ConnectUrl, TRAVEL_Absolute, false, FGuid());
            FinishRequest(true, TEXT("RIDGE სერვერთან დაკავშირება დაიწყო."));
        });

    if (!Request->ProcessRequest())
    {
        bRequestInFlight = false;
        Finish(false, TEXT("RIDGE Gateway-თან HTTP მოთხოვნის დაწყება ვერ მოხერხდა."));
    }
}
