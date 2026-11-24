#include "RidgePlayerState.h"
#include "Net/UnrealNetwork.h"

bool ARidgePlayerState::SetVerifiedPlayerId(const FString& InVerifiedPlayerId)
{
    if (!HasAuthority() || InVerifiedPlayerId.IsEmpty() || InVerifiedPlayerId.Len() > 80)
    {
        return false;
    }

    for (const TCHAR Character : InVerifiedPlayerId)
    {
        const bool bAllowed =
            (Character >= TEXT('a') && Character <= TEXT('z')) ||
            (Character >= TEXT('A') && Character <= TEXT('Z')) ||
            (Character >= TEXT('0') && Character <= TEXT('9')) ||
            Character == TEXT('.') || Character == TEXT('_') ||
            Character == TEXT(':') || Character == TEXT('-');
        if (!bAllowed)
        {
            return false;
        }
    }

    VerifiedPlayerId = InVerifiedPlayerId;
    return true;
}

FString ARidgePlayerState::GetBackendPlayerId() const
{
    // Offline/development sessions keep working with the prototype public ID.
    // Dedicated servers always set VerifiedPlayerId before accepting a player.
    return VerifiedPlayerId.IsEmpty() ? RidgePublicId : VerifiedPlayerId;
}


void ARidgePlayerState::BeginPlay()
{
    Super::BeginPlay();

    if (HasAuthority() && RidgePublicId.IsEmpty())
    {
        RidgePublicId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
    }
}

void ARidgePlayerState::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(ARidgePlayerState, RidgePublicId);
}