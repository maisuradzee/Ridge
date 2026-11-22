using UnrealBuildTool;

public class RIDGE : ModuleRules
{
    public RIDGE(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "InputCore",
            "Http",
            "Json",
            "JsonUtilities",
            "AIModule",
            "NavigationSystem"
        });
    }
}