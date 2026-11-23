#include "RidgeCharacter.h"
#include "RidgeBackendSubsystem.h"
#include "RidgePlayerState.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/Controller.h"
#include "GameFramework/InputSettings.h"
#include "GameFramework/SpringArmComponent.h"
#include "Components/StaticMeshComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "Net/UnrealNetwork.h"

ARidgeCharacter::ARidgeCharacter()
{
    PrimaryActorTick.bCanEverTick = true;

    bReplicates = true;
    SetReplicateMovement(true);
    NetUpdateFrequency = 66.0f;
    MinNetUpdateFrequency = 33.0f;

    GetCapsuleComponent()->InitCapsuleSize(42.0f, 96.0f);

    bUseControllerRotationPitch = false;
    bUseControllerRotationYaw = false;
    bUseControllerRotationRoll = false;

    UCharacterMovementComponent* Movement = GetCharacterMovement();
    Movement->bOrientRotationToMovement = true;
    Movement->RotationRate = FRotator(0.0f, 540.0f, 0.0f);
    Movement->JumpZVelocity = 520.0f;
    Movement->AirControl = 0.25f;
    Movement->MaxWalkSpeed = WalkSpeed;
    Movement->bCanCrouch = true;
    Movement->MaxWalkSpeedCrouched = 180.0f;
    Movement->BrakingDecelerationWalking = 1800.0f;
    Movement->GroundFriction = 8.0f;

    CameraBoom = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraBoom"));
    CameraBoom->SetupAttachment(RootComponent);
    CameraBoom->TargetArmLength = 360.0f;
    CameraBoom->bUsePawnControlRotation = true;
    CameraBoom->bDoCollisionTest = true;
    CameraBoom->bEnableCameraLag = true;
    CameraBoom->CameraLagSpeed = 12.0f;
    CameraBoom->CameraLagMaxDistance = 80.0f;
    CameraBoom->bEnableCameraRotationLag = true;
    CameraBoom->CameraRotationLagSpeed = 14.0f;

    FollowCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("FollowCamera"));
    FollowCamera->SetupAttachment(CameraBoom, USpringArmComponent::SocketName);
    FollowCamera->bUsePawnControlRotation = false;

    // Visible primitive proxy makes the movement prototype inspectable before
    // a licensed/final skeletal mesh and Animation Blueprint are integrated.
    static ConstructorHelpers::FObjectFinder<UStaticMesh> BodyMeshAsset(
        TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
    PlaceholderBody = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("PlaceholderBody"));
    PlaceholderBody->SetupAttachment(RootComponent);
    PlaceholderBody->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    PlaceholderBody->SetGenerateOverlapEvents(false);
    PlaceholderBody->SetCanEverAffectNavigation(false);
    PlaceholderBody->SetRelativeLocation(FVector(0.0f, 0.0f, -10.0f));
    PlaceholderBody->SetRelativeScale3D(FVector(0.55f, 0.55f, 1.5f));
    if (BodyMeshAsset.Succeeded())
    {
        PlaceholderBody->SetStaticMesh(BodyMeshAsset.Object);
    }

    static ConstructorHelpers::FObjectFinder<UStaticMesh> HeadMeshAsset(
        TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    PlaceholderHead = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("PlaceholderHead"));
    PlaceholderHead->SetupAttachment(RootComponent);
    PlaceholderHead->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    PlaceholderHead->SetGenerateOverlapEvents(false);
    PlaceholderHead->SetCanEverAffectNavigation(false);
    PlaceholderHead->SetRelativeLocation(FVector(0.0f, 0.0f, 72.0f));
    PlaceholderHead->SetRelativeScale3D(FVector(0.35f, 0.35f, 0.35f));
    if (HeadMeshAsset.Succeeded())
    {
        PlaceholderHead->SetStaticMesh(HeadMeshAsset.Object);
    }
}

void ARidgeCharacter::BeginPlay()
{
    Super::BeginPlay();
    if (HasAuthority())
    {
        Stamina = MaxStamina;
    }
    ApplyMovementSpeed();
}

void ARidgeCharacter::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);

    // Stamina is changed only by the server. The owning client receives
    // replicated updates for UI and local sprint availability.
    if (HasAuthority())
    {
        if (bIsSprinting)
        {
            Stamina = FMath::Max(0.0f, Stamina - SprintStaminaDrainPerSecond * DeltaSeconds);
            if (Stamina <= KINDA_SMALL_NUMBER)
            {
                SetSprinting(false);
            }
        }
        else
        {
            Stamina = FMath::Min(MaxStamina, Stamina + StaminaRegenPerSecond * DeltaSeconds);
        }
    }
}

void ARidgeCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);
    check(PlayerInputComponent);

    PlayerInputComponent->BindAxis(TEXT("MoveForward"), this, &ARidgeCharacter::MoveForward);
    PlayerInputComponent->BindAxis(TEXT("MoveRight"), this, &ARidgeCharacter::MoveRight);
    PlayerInputComponent->BindAxis(TEXT("Turn"), this, &APawn::AddControllerYawInput);
    PlayerInputComponent->BindAxis(TEXT("LookUp"), this, &APawn::AddControllerPitchInput);
    PlayerInputComponent->BindAxis(TEXT("CameraZoom"), this, &ARidgeCharacter::AdjustCameraZoom);

    PlayerInputComponent->BindAction(TEXT("Jump"), IE_Pressed, this, &ACharacter::Jump);
    PlayerInputComponent->BindAction(TEXT("Jump"), IE_Released, this, &ACharacter::StopJumping);
    PlayerInputComponent->BindAction(TEXT("Sprint"), IE_Pressed, this, &ARidgeCharacter::SprintPressed);
    PlayerInputComponent->BindAction(TEXT("Sprint"), IE_Released, this, &ARidgeCharacter::SprintReleased);
    PlayerInputComponent->BindAction(TEXT("Crouch"), IE_Pressed, this, &ARidgeCharacter::CrouchPressed);
    PlayerInputComponent->BindAction(TEXT("Crouch"), IE_Released, this, &ARidgeCharacter::CrouchReleased);
    PlayerInputComponent->BindAction(TEXT("AcceptDelivery"), IE_Pressed, this, &ARidgeCharacter::RequestDeliveryJob);
}

void ARidgeCharacter::MoveForward(float Value)
{
    if (Controller && FMath::Abs(Value) > KINDA_SMALL_NUMBER)
    {
        const FRotator YawRotation(0.0f, Controller->GetControlRotation().Yaw, 0.0f);
        AddMovementInput(FRotationMatrix(YawRotation).GetUnitAxis(EAxis::X), Value);
    }
}

void ARidgeCharacter::MoveRight(float Value)
{
    if (Controller && FMath::Abs(Value) > KINDA_SMALL_NUMBER)
    {
        const FRotator YawRotation(0.0f, Controller->GetControlRotation().Yaw, 0.0f);
        AddMovementInput(FRotationMatrix(YawRotation).GetUnitAxis(EAxis::Y), Value);
    }
}

void ARidgeCharacter::RequestDeliveryJob()
{
    if (HasAuthority())
    {
        ServerRequestDeliveryJob_Implementation();
    }
    else
    {
        ServerRequestDeliveryJob();
    }
}

void ARidgeCharacter::ServerRequestDeliveryJob_Implementation()
{
    if (!HasAuthority())
    {
        return;
    }

    ARidgePlayerState* RidgeState = GetPlayerState<ARidgePlayerState>();
    if (!RidgeState)
    {
        return;
    }
    const FString BackendPlayerId = RidgeState->GetBackendPlayerId();
    if (BackendPlayerId.IsEmpty())
    {
        return;
    }

    if (UGameInstance* GameInstance = GetGameInstance())
    {
        if (URidgeBackendSubsystem* Backend = GameInstance->GetSubsystem<URidgeBackendSubsystem>())
        {
            Backend->AcceptDeliveryJob(BackendPlayerId);
        }
    }
}

void ARidgeCharacter::SprintPressed()
{
    if (!bIsCrouched && Stamina > KINDA_SMALL_NUMBER)
    {
        SetSprinting(true);
    }
}

void ARidgeCharacter::SprintReleased()
{
    SetSprinting(false);
}

void ARidgeCharacter::CrouchPressed()
{
    SetSprinting(false);
    Crouch();
}

void ARidgeCharacter::CrouchReleased()
{
    UnCrouch();
}

void ARidgeCharacter::AdjustCameraZoom(float Value)
{
    if (FollowCamera && CameraBoom && FMath::Abs(Value) > KINDA_SMALL_NUMBER)
    {
        CameraBoom->TargetArmLength = FMath::Clamp(
            CameraBoom->TargetArmLength - (Value * 35.0f),
            MinCameraArmLength,
            MaxCameraArmLength);
    }
}

void ARidgeCharacter::SetSprinting(bool bNewSprinting)
{
    const bool bCanSprint = bNewSprinting && !bIsCrouched && Stamina > KINDA_SMALL_NUMBER;
    bIsSprinting = bCanSprint;
    ApplyMovementSpeed();

    if (HasAuthority())
    {
        ForceNetUpdate();
    }
    else
    {
        ServerSetSprinting(bCanSprint);
    }
}

void ARidgeCharacter::ServerSetSprinting_Implementation(bool bNewSprinting)
{
    bIsSprinting = bNewSprinting && !bIsCrouched && Stamina > KINDA_SMALL_NUMBER;
    ApplyMovementSpeed();
    ForceNetUpdate();
}

void ARidgeCharacter::ApplyMovementSpeed()
{
    if (UCharacterMovementComponent* Movement = GetCharacterMovement())
    {
        Movement->MaxWalkSpeed = bIsSprinting ? SprintSpeed : WalkSpeed;
    }
}

void ARidgeCharacter::OnRep_Stamina()
{
    if (Stamina <= KINDA_SMALL_NUMBER && bIsSprinting)
    {
        bIsSprinting = false;
    }
    ApplyMovementSpeed();
}

void ARidgeCharacter::OnRep_IsSprinting()
{
    ApplyMovementSpeed();
}

void ARidgeCharacter::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME_CONDITION(ARidgeCharacter, Stamina, COND_OwnerOnly);
    DOREPLIFETIME(ARidgeCharacter, bIsSprinting);
}