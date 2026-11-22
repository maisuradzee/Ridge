using UnrealBuildTool;
using System.Collections.Generic;

public class RIDGEServerTarget : TargetRules
{
    public RIDGEServerTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Server;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("RIDGE");
    }
}