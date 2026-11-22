#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "RidgeCharacter.generated.h"

class UCameraComponent;
class USpringArmComponent;
class UStaticMeshComponent;

/**
 * Server-authoritative third-person character foundation for RIDGE.
 * Movement uses Unreal CharacterMovement replication; sprint stamina is
 * authoritative on the server and replicated to the owning client.
 */
UCLASS()
class RIDGE_API ARidgeCharacter : public ACharacter
{
    GENERATED_BODY()

public:
    ARidgeCharacter();

    virtual void Tick(float DeltaSeconds) override;
    virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;

protected:
    virtual void BeginPlay() override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

private:
    UPROPERTY(VisibleAnywhere, Category = "RIDGE|Camera")
    TObjectPtr<USpringArmComponent> CameraBoom;

    UPROPERTY(VisibleAnywhere, Category = "RIDGE|Camera")
    TObjectPtr<UCameraComponent> FollowCamera;

    // Temporary primitive silhouette until the final skeletal character asset is ready.
    UPROPERTY(VisibleAnywhere, Category = "RIDGE|Visual")
    TObjectPtr<UStaticMeshComponent> PlaceholderBody;

    UPROPERTY(VisibleAnywhere, Category = "RIDGE|Visual")
    TObjectPtr<UStaticMeshComponent> PlaceholderHead;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Movement", meta = (ClampMin = "100.0"))
    float WalkSpeed = 420.0f;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Movement", meta = (ClampMin = "100.0"))
    float SprintSpeed = 620.0f;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Movement", meta = (ClampMin = "0.1"))
    float SprintStaminaDrainPerSecond = 24.0f;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Movement", meta = (ClampMin = "0.1"))
    float StaminaRegenPerSecond = 18.0f;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Camera", meta = (ClampMin = "100.0", ClampMax = "800.0"))
    float MinCameraArmLength = 250.0f;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Camera", meta = (ClampMin = "100.0", ClampMax = "1000.0"))
    float MaxCameraArmLength = 500.0f;

    UPROPERTY(ReplicatedUsing = OnRep_Stamina, VisibleAnywhere, BlueprintReadOnly, Category = "RIDGE|Movement", meta = (AllowPrivateAccess = "true"))
    float Stamina = 100.0f;

    UPROPERTY(EditDefaultsOnly, Category = "RIDGE|Movement", meta = (ClampMin = "1.0"))
    float MaxStamina = 100.0f;

    UPROPERTY(ReplicatedUsing = OnRep_IsSprinting, VisibleAnywhere, BlueprintReadOnly, Category = "RIDGE|Movement", meta = (AllowPrivateAccess = "true"))
    bool bIsSprinting = false;

    void MoveForward(float Value);
    void MoveRight(float Value);
    void SprintPressed();
    void SprintReleased();
    void RequestDeliveryJob();

    UFUNCTION(Server, Reliable)
    void ServerRequestDeliveryJob();
    void CrouchPressed();
    void CrouchReleased();
    void AdjustCameraZoom(float Value);
    void SetSprinting(bool bNewSprinting);
    void ApplyMovementSpeed();

    UFUNCTION(Server, Reliable)
    void ServerSetSprinting(bool bNewSprinting);

    UFUNCTION()
    void OnRep_Stamina();

    UFUNCTION()
    void OnRep_IsSprinting();
};