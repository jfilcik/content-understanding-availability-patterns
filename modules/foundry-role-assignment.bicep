// =====================================================================================
// Grants a managed identity data-plane access to an Azure AI Foundry resource.
// This supports APIM-to-ACU and same-region ACU-to-AOAI role assignments.
// =====================================================================================

@description('Name of the existing Azure AI Foundry (Cognitive Services) account.')
param foundryName string

@description('Principal ID of the calling system-assigned managed identity.')
param principalId string

@description('Role to assign. Defaults to "Cognitive Services OpenAI User".')
param roleDefinitionId string = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryName
}

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, principalId, roleDefinitionId)
  scope: foundry
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
  }
}
