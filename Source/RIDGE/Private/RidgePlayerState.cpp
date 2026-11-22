#include "RidgePlayerState.h"
#include "Net/UnrealNetwork.h"

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