@description('Name of the existing Content Understanding Foundry account.')
param acuName string

@description('Name of the Azure OpenAI connection on the Content Understanding account.')
param connectionName string

@description('Endpoint of the co-located Azure OpenAI resource.')
param aoaiEndpoint string

@description('ARM resource ID of the co-located Azure OpenAI resource.')
param aoaiResourceId string

@description('Azure region of the co-located Azure OpenAI resource.')
param aoaiLocation string

resource acu 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: acuName
}

resource connection 'Microsoft.CognitiveServices/accounts/connections@2025-06-01' = {
  parent: acu
  name: connectionName
  properties: {
    category: 'AzureOpenAI'
    target: aoaiEndpoint
    authType: 'AAD'
    useWorkspaceManagedIdentity: true
    isSharedToAll: true
    metadata: {
      ApiType: 'Azure'
      ResourceId: aoaiResourceId
      Location: aoaiLocation
    }
  }
}
