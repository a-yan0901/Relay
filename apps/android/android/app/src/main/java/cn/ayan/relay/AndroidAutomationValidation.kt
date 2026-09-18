package cn.ayan.relay

/**
 * Validation shared by Android snippet storage and the future local command
 * runner. Keep this independent from Android UI classes so the boundary can
 * be exercised by the JVM test suite.
 */
internal object AndroidAutomationValidation {
    private const val MAX_NAME_LENGTH = 120
    private const val MAX_DESCRIPTION_LENGTH = 500
    private const val MAX_TAGS = 20
    private const val MAX_TAG_LENGTH = 64
    private const val MAX_COMMAND_LENGTH = 48 * 1024
    private const val MAX_VARIABLES = 64
    private const val MAX_VARIABLE_NAME_LENGTH = 64
    private const val MAX_VARIABLE_VALUE_LENGTH = 4096
    private val variableName = Regex("^[a-z][a-z0-9_]*$")
    private val variableToken = Regex("\\{\\{([^{}]+)\\}\\}")

    internal data class SnippetDraft(
        val name: String,
        val description: String?,
        val tags: List<String>,
        val command: String,
        val variables: List<String>
    )

    fun validateSnippet(
        name: String,
        description: String?,
        tags: List<String>,
        command: String,
        variables: List<String>
    ): SnippetDraft {
        requireText(name, MAX_NAME_LENGTH)
        if (description != null && description.length > MAX_DESCRIPTION_LENGTH) invalid()
        if (tags.size > MAX_TAGS) invalid()
        val normalizedTags = LinkedHashSet<String>()
        tags.forEach {
            val tag = it.trim()
            requireText(tag, MAX_TAG_LENGTH)
            normalizedTags += tag
        }
        if (command.length !in 1..MAX_COMMAND_LENGTH || command.trim().isEmpty()) invalid()
        val normalizedVariables = validateVariables(command, variables)
        return SnippetDraft(name, description, normalizedTags.toList(), command, normalizedVariables)
    }

    fun validateVariables(command: String, declared: List<String>): List<String> {
        if (declared.size > MAX_VARIABLES || declared.toSet().size != declared.size) invalid()
        declared.forEach { validateVariableName(it) }
        val referenced = ArrayList<String>()
        variableToken.findAll(command).forEach { match ->
            val name = match.groupValues[1]
            validateVariableName(name)
            if (!referenced.contains(name)) referenced += name
        }
        val stripped = variableToken.replace(command, "")
        if (stripped.contains("{{") || stripped.contains("}}")) invalid()
        if (referenced.any { it !in declared }) invalid()
        return declared.toList()
    }

    fun expandCommand(command: String, values: Map<String, String>, declared: List<String>): String {
        validateVariables(command, declared)
        if (values.keys.any { it !in declared || it.length > MAX_VARIABLE_NAME_LENGTH }) invalid()
        values.values.forEach { if (it.length > MAX_VARIABLE_VALUE_LENGTH) invalid() }
        return variableToken.replace(command) { match -> values[match.groupValues[1]] ?: "" }
    }

    fun validateVariableName(value: String) {
        if (value.length !in 1..MAX_VARIABLE_NAME_LENGTH || !variableName.matches(value)) invalid()
    }

    fun validateVariableValue(value: String) {
        if (value.length > MAX_VARIABLE_VALUE_LENGTH || value.any { it.code <= 0x1f || it.code == 0x7f }) invalid()
    }

    private fun requireText(value: String, maxLength: Int) {
        if (value.isEmpty() || value.length > maxLength || value.any { it.code <= 0x1f || it.code == 0x7f }) invalid()
    }

    private fun invalid(): Nothing = throw NativeVaultFailure("COMMAND_RUN_VALIDATION_FAILED")
}
