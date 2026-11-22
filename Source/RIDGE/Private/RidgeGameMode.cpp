#include "RidgeGameMode.h"
#include "RidgeCharacter.h"
#include "RidgeGameState.h"
#include "RidgePlayerState.h"

ARidgeGameMode::ARidgeGameMode()
{
    DefaultPawnClass = ARidgeCharacter::StaticClass();
    GameStateClass = ARidgeGameState::StaticClass();
    PlayerStateClass = ARidgePlayerState::StaticClass();
}