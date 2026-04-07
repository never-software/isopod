# Step 1: Resolve provider configuration from amp_providers variable.
#
# Reads the amp_providers Windmill variable, selects the provider entry
# that matches the requested model, and returns the resolved config
# (provider name, api_base, api_key, model) for step 2.

require 'json'

def main(model:, stream: false, messages: [], **kwargs)
  # Load provider config from Windmill variable
  providers_json = get_variable("f/ai/amp_providers")
  providers = JSON.parse(providers_json)

  resolved = nil

  providers.each do |provider_name, config|
    if config["models"]&.key?(model) || config["default_model"] == model
      api_key = get_variable(config["api_key_variable"])
      resolved = {
        "provider" => provider_name,
        "api_base" => config["api_base"],
        "api_key" => api_key,
        "model" => model || config["default_model"],
        "stream" => stream,
        "messages" => messages
      }
      # Merge any extra kwargs (temperature, max_tokens, etc.)
      kwargs.each { |k, v| resolved[k.to_s] = v }
      break
    end
  end

  if resolved.nil?
    # Default to first provider if model not explicitly mapped
    provider_name, config = providers.first
    api_key = get_variable(config["api_key_variable"])
    resolved = {
      "provider" => provider_name,
      "api_base" => config["api_base"],
      "api_key" => api_key,
      "model" => model || config["default_model"],
      "stream" => stream,
      "messages" => messages
    }
    kwargs.each { |k, v| resolved[k.to_s] = v }
  end

  resolved
end
