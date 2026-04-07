# Step 1: Resolve provider configuration from the amp_providers variable.
#
# Reads the f/ai/amp_providers variable, picks the right provider based on
# the requested model, and returns { provider, model, api_key } for step 2.

require 'yaml'
require 'json'
require 'wmill'

def main(model: nil, **_kwargs)
  raw = Wmill.get_variable('f/ai/amp_providers')
  config = YAML.safe_load(raw)

  provider_name = config['default_provider']

  # If a model is specified, find which provider owns it
  if model && !model.empty?
    config['providers'].each do |name, prov|
      if prov['models']&.include?(model)
        provider_name = name
        break
      end
    end
  end

  provider = config['providers'][provider_name]
  raise "Unknown provider: #{provider_name}" unless provider

  resolved_model = model && !model.empty? ? model : provider['default_model']

  # Resolve the API key from Windmill secrets
  api_key = Wmill.get_variable(provider['api_key_variable'])

  {
    'provider' => provider_name,
    'litellm_provider' => provider['litellm_provider'],
    'model' => resolved_model,
    'api_key' => api_key
  }
end
