@description('Globally unique name of the Microsoft Foundry resource.')
param name string

@description('Azure region for the Microsoft Foundry resource.')
param location string

@description('SKU for the Microsoft Foundry resource.')
param skuName string = 'S0'

@description('Enables project management capabilities on the Microsoft Foundry resource.')
param allowProjectManagement bool = true

@description('Controls public endpoint access for the Microsoft Foundry resource.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Enabled'

@description('Default network ACL action for the Microsoft Foundry resource.')
@allowed([
  'Allow'
  'Deny'
])
param networkAclsDefaultAction string = 'Allow'

@description('Name of the chat/completions model deployment.')
param modelDeploymentName string = 'gpt-5.2'

@description('Azure OpenAI model name deployed for chat/completions.')
param modelName string = 'gpt-5.2'

@description('Azure OpenAI model version deployed for chat/completions.')
param modelVersion string = '2025-12-11'

@description('Deployment SKU for both model deployments. Standard is the regional deployment type.')
@allowed([
  'GlobalStandard'
  'DataZoneStandard'
  'Standard'
])
param modelDeploymentSkuName string = 'GlobalStandard'

@description('Version upgrade policy for the chat/completions model deployment.')
param modelVersionUpgradeOption string = 'NoAutoUpgrade'

@description('Deployment capacity in thousands of tokens per minute.')
@minValue(1)
param modelCapacity int = 10

@description('Name of the embedding model deployment.')
param embeddingDeploymentName string = 'text-embedding-3-large'

@description('Azure OpenAI embedding model name.')
param embeddingModelName string = 'text-embedding-3-large'

@description('Azure OpenAI embedding model version.')
param embeddingModelVersion string = '1'

@description('Deployment SKU for the embedding model deployment.')
@allowed([
  'GlobalStandard'
  'DataZoneStandard'
  'Standard'
])
param embeddingDeploymentSkuName string = modelDeploymentSkuName

@description('Version upgrade policy for the embedding model deployment.')
param embeddingModelVersionUpgradeOption string = 'NoAutoUpgrade'

@description('Capacity assigned to the embedding model deployment.')
@minValue(1)
param embeddingCapacity int = 10

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: name
  location: location
  kind: 'AIServices'
  sku: {
    name: skuName
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowProjectManagement: allowProjectManagement
    customSubDomainName: name
    disableLocalAuth: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      defaultAction: networkAclsDefaultAction
    }
  }
}

resource gpt52Deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: modelDeploymentName
  sku: {
    name: modelDeploymentSkuName
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: modelVersionUpgradeOption
  }
}

resource textEmbedding3LargeDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: embeddingDeploymentName
  sku: {
    name: embeddingDeploymentSkuName
    capacity: embeddingCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: embeddingModelName
      version: embeddingModelVersion
    }
    versionUpgradeOption: embeddingModelVersionUpgradeOption
  }
  dependsOn: [gpt52Deployment]
}

@description('Name of the Microsoft Foundry resource.')
output name string = foundry.name

@description('ARM resource ID of the Microsoft Foundry resource.')
output resourceId string = foundry.id

@description('Azure region of the Microsoft Foundry resource.')
output location string = foundry.location

@description('Cognitive Services endpoint used by Content Understanding and Azure OpenAI.')
output endpoint string = foundry.properties.endpoint

@description('Principal ID of the Microsoft Foundry resource system-assigned identity.')
output principalId string = foundry.identity.principalId

@description('Name of the chat/completions model deployment.')
output modelDeploymentName string = gpt52Deployment.name

@description('Name of the embedding model deployment.')
output embeddingDeploymentName string = textEmbedding3LargeDeployment.name
